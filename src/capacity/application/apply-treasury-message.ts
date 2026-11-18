import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Db, type DbTransaction } from '../../database/database';
import { type NewLedgerEntry } from '../../database/database.types';
import { Money } from '../../money';
import {
  type InvoiceRepaid,
  type ParsedTreasuryMessage,
  parseTreasuryMessage,
  type ProgramLimitSet,
  type ProgramSnapshot,
  TreasuryMessageType,
} from '../../treasury/treasury-messages';
import { CapacityError } from '../domain/errors';
import { type Program } from '../domain/model';
import { decideOrdering, type MessageClass } from '../domain/ordering';
import {
  planReconciliation,
  type ReconciliationChange,
  type ReconciliationPlan,
} from '../domain/reconciliation';
import {
  CapacityRepository,
  type NewReservation,
  type ReservationRebook,
} from '../infrastructure/capacity.repository';
import {
  type MessageSource,
  type PendingLimit,
  type StreamPosition,
  TreasuryRepository,
} from '../infrastructure/treasury.repository';
import { ReleaseProcessor } from './release-processor';

export const TREASURY_ACTOR = 'treasury';

const DRAIN_BATCH = 100;

export type ReadableTreasuryMessage = Extract<ParsedTreasuryMessage, { kind: 'readable' }>;

export interface InboundTreasuryMessage {
  readonly parsed: ReadableTreasuryMessage;
  readonly rawValue: string;
  readonly source: MessageSource;
}

export type TreasuryOutcome = 'APPLIED' | 'PARKED' | 'STALE' | 'DUPLICATE' | 'REJECTED';

export interface ApplyTreasuryResult {
  readonly outcome: TreasuryOutcome;
  readonly reason: string | null;
  readonly drained: number;
  readonly deadLettered: number;
}

type Received = Omit<ApplyTreasuryResult, 'drained'>;

type ApplyResult = { applied: true } | { applied: false; reason: string };

type HandleResult = ApplyResult & { deadLettered: number };

interface DrainResult {
  readonly drained: number;
  readonly deadLettered: number;
}

const APPLIED: ApplyResult = { applied: true };

function rejected(reason: string): ApplyResult {
  return { applied: false, reason };
}

@Injectable()
export class ApplyTreasuryMessage {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CapacityRepository) private readonly capacity: CapacityRepository,
    @Inject(TreasuryRepository) private readonly treasury: TreasuryRepository,
    @Inject(ReleaseProcessor) private readonly releases: ReleaseProcessor,
  ) {}

  async execute(inbound: InboundTreasuryMessage): Promise<ApplyTreasuryResult> {
    const received = await this.db.transaction().execute((trx) => this.receive(trx, inbound));
    const drain = await this.drain(inbound.parsed.envelope.programId);
    return {
      ...received,
      drained: drain.drained,
      deadLettered: received.deadLettered + drain.deadLettered,
    };
  }

  private async receive(trx: DbTransaction, inbound: InboundTreasuryMessage): Promise<Received> {
    const { envelope } = inbound.parsed;
    const stream = await this.treasury.lockStream(trx, envelope.programId);
    const fingerprint = fingerprintOf(inbound.rawValue);
    const known = await this.treasury.findFingerprint(trx, envelope.messageId);
    if (known?.equals(fingerprint) === true) {
      return { outcome: 'DUPLICATE', reason: null, deadLettered: 0 };
    }
    if (known !== null) {
      const reason = `Message ID ${envelope.messageId} was already used for a different message`;
      const deadLettered = await this.deadLetter(trx, inbound, reason);
      return { outcome: 'REJECTED', reason, deadLettered };
    }

    const revision = BigInt(envelope.revision);
    const decision = decideOrdering(stream.revision, revision, classify(inbound.parsed));
    if (decision === 'STALE') {
      const reason = `Revision ${revision} is not newer than applied revision ${stream.revision}`;
      await this.treasury.recordProcessed(trx, processed(inbound, fingerprint, 'STALE', reason));
      return { outcome: 'STALE', reason, deadLettered: 0 };
    }
    if (decision === 'PARK') {
      return this.park(trx, inbound, stream, fingerprint);
    }

    await this.treasury.recordProcessed(trx, processed(inbound, fingerprint, 'APPLIED', null));
    const result = await this.handle(trx, stream, inbound);
    return {
      outcome: result.applied ? 'APPLIED' : 'REJECTED',
      reason: result.applied ? null : result.reason,
      deadLettered: result.deadLettered,
    };
  }

  private async park(
    trx: DbTransaction,
    inbound: InboundTreasuryMessage,
    stream: StreamPosition,
    fingerprint: Buffer,
  ): Promise<Received> {
    const { envelope, message } = inbound.parsed;
    const reason = `Waiting for revision ${stream.revision + 1n}`;
    await this.treasury.recordProcessed(trx, processed(inbound, fingerprint, 'PARKED', reason));
    const parked = await this.treasury.park(trx, {
      messageId: envelope.messageId,
      programId: envelope.programId,
      revision: BigInt(envelope.revision),
      rawValue: inbound.rawValue,
      rejected: false,
      limit: message?.type === TreasuryMessageType.ProgramLimitSet ? pendingLimit(message) : null,
      source: inbound.source,
    });
    if (parked) {
      return { outcome: 'PARKED', reason, deadLettered: 0 };
    }
    const conflict = `Another message is already parked for revision ${envelope.revision}`;
    const deadLettered = await this.reject(trx, inbound, conflict);
    return { outcome: 'REJECTED', reason: conflict, deadLettered };
  }

  private async drain(programId: string): Promise<DrainResult> {
    let drained = 0;
    let deadLettered = 0;
    for (;;) {
      const batch = await this.db.transaction().execute((trx) => this.drainBatch(trx, programId));
      drained += batch.drained;
      deadLettered += batch.deadLettered;
      if (batch.drained < DRAIN_BATCH) {
        return { drained, deadLettered };
      }
    }
  }

  private async drainBatch(trx: DbTransaction, programId: string): Promise<DrainResult> {
    let drained = 0;
    let deadLettered = 0;
    while (drained < DRAIN_BATCH) {
      const stream = await this.treasury.lockStream(trx, programId);
      const next = await this.treasury.takePending(trx, programId, stream.revision + 1n);
      if (next === null) {
        return { drained, deadLettered };
      }
      drained += 1;
      if (next.rejected) {
        await this.treasury.setStreamRevision(trx, programId, next.revision);
        continue;
      }
      const parsed = parseTreasuryMessage(next.rawValue);
      if (parsed.kind === 'unreadable') {
        throw new Error(`Parked message ${next.messageId} is unreadable`);
      }
      const result = await this.handle(trx, stream, {
        parsed,
        rawValue: next.rawValue,
        source: next.source,
      });
      deadLettered += result.deadLettered;
      if (result.applied) {
        await this.treasury.updateOutcome(trx, next.messageId, 'APPLIED', null);
      }
    }
    return { drained, deadLettered };
  }

  private async handle(
    trx: DbTransaction,
    stream: StreamPosition,
    inbound: InboundTreasuryMessage,
  ): Promise<HandleResult> {
    const { envelope, message } = inbound.parsed;
    const revision = BigInt(envelope.revision);
    const program = await this.capacity.lockProgram(trx, envelope.programId);
    const result = await this.dispatch(trx, program, stream, inbound.parsed);
    if (result.applied) {
      const snapshotAsOf =
        message?.type === TreasuryMessageType.ProgramSnapshot ? new Date(message.asOf) : undefined;
      await this.treasury.setStreamRevision(trx, envelope.programId, revision, snapshotAsOf);
      return { ...result, deadLettered: 0 };
    }
    const deadLettered = await this.reject(trx, inbound, result.reason);
    if (revision === stream.revision + 1n) {
      await this.treasury.setStreamRevision(trx, envelope.programId, revision);
      return { ...result, deadLettered };
    }
    await this.treasury.park(trx, {
      messageId: envelope.messageId,
      programId: envelope.programId,
      revision,
      rawValue: inbound.rawValue,
      rejected: true,
      limit: null,
      source: inbound.source,
    });
    return { ...result, deadLettered };
  }

  private async reject(
    trx: DbTransaction,
    inbound: InboundTreasuryMessage,
    reason: string,
  ): Promise<number> {
    await this.treasury.updateOutcome(trx, inbound.parsed.envelope.messageId, 'REJECTED', reason);
    return this.deadLetter(trx, inbound, reason);
  }

  private async deadLetter(
    trx: DbTransaction,
    inbound: InboundTreasuryMessage,
    reason: string,
  ): Promise<number> {
    const { envelope } = inbound.parsed;
    const added = await this.treasury.addDeadLetter(trx, {
      messageId: envelope.messageId,
      programId: envelope.programId,
      revision: BigInt(envelope.revision),
      reason,
      key: Buffer.from(envelope.programId, 'utf8'),
      payload: Buffer.from(inbound.rawValue, 'utf8'),
      source: inbound.source,
    });
    return added ? 1 : 0;
  }

  private async dispatch(
    trx: DbTransaction,
    program: Program | null,
    stream: StreamPosition,
    parsed: ReadableTreasuryMessage,
  ): Promise<ApplyResult> {
    const message = parsed.message;
    if (message === null) {
      return rejected(parsed.error ?? 'Invalid message');
    }
    try {
      if (message.type === TreasuryMessageType.ProgramLimitSet) {
        return await this.setLimit(trx, program, message);
      }
      if (message.type === TreasuryMessageType.InvoiceRepaid) {
        return await this.repay(trx, program, message);
      }
      return await this.reconcile(trx, program, stream, message);
    } catch (error) {
      if (error instanceof CapacityError) {
        return rejected(`${error.code}: ${error.message}`);
      }
      throw error;
    }
  }

  private async setLimit(
    trx: DbTransaction,
    program: Program | null,
    message: ProgramLimitSet,
  ): Promise<ApplyResult> {
    if (program === null) {
      await this.createProgram(trx, message, message.limit);
      return APPLIED;
    }
    if (program.currency !== message.currency) {
      return rejected(
        `Programme currency ${program.currency} cannot change to ${message.currency}`,
      );
    }
    const updated = await this.capacity.updateProgram(trx, program, {
      limitMinor: message.limit,
      utilisedMinor: program.utilisedMinor,
    });
    await this.capacity.appendLedger(trx, [
      ledger(updated, message.messageId, {
        type: 'LIMIT_SET',
        delta_minor: updated.limitMinor - program.limitMinor,
        reason: 'TREASURY_LIMIT_SET',
      }),
    ]);
    return APPLIED;
  }

  private async repay(
    trx: DbTransaction,
    program: Program | null,
    message: InvoiceRepaid,
  ): Promise<ApplyResult> {
    if (program === null) {
      return rejected(`Programme ${message.programId} is unknown`);
    }
    await this.releases.releaseLocked(trx, program, {
      invoiceId: message.invoiceId,
      releaseId: message.releaseId,
      amount:
        message.amount === undefined
          ? null
          : Money.of(message.amount.amount, message.amount.currency),
      origin: 'TREASURY',
      actor: { subject: TREASURY_ACTOR, correlationId: null },
      sourceMessageId: message.messageId,
    });
    return APPLIED;
  }

  private async reconcile(
    trx: DbTransaction,
    existing: Program | null,
    stream: StreamPosition,
    message: ProgramSnapshot,
  ): Promise<ApplyResult> {
    if (existing !== null && existing.currency !== message.currency) {
      return rejected(
        `Programme currency ${existing.currency} cannot change to ${message.currency}`,
      );
    }
    const asOf = new Date(message.asOf);
    if (stream.snapshotAsOf !== null && asOf < stream.snapshotAsOf) {
      return rejected(
        `Snapshot asOf ${asOf.toISOString()} is older than the last applied snapshot (${stream.snapshotAsOf.toISOString()})`,
      );
    }
    const revision = BigInt(message.revision);
    const local =
      existing === null
        ? []
        : await this.capacity.listReservationsForReconciliation(
            trx,
            existing.id,
            message.reservations.map((entry) => entry.invoiceId),
          );
    const baseline = existing ?? virtualProgram(message);
    const plan = planReconciliation(baseline, local, {
      limitMinor: message.limit,
      reservations: message.reservations.map((entry) => ({
        invoiceId: entry.invoiceId,
        invoiceAmountMinor: entry.invoiceAmount,
        invoiceCurrency: entry.invoiceCurrency,
        outstandingInvoiceMinor: entry.outstandingInvoiceAmount,
        bookedMinor: entry.bookedAmount,
      })),
    });
    const program = existing ?? (await this.createProgram(trx, message, message.limit));
    await this.applyPlan(trx, program, plan, message);
    await this.treasury.recordDiscrepancies(trx, program.id, plan.discrepancies, {
      messageId: message.messageId,
      revision,
    });
    await this.treasury.supersedePending(trx, program.id, revision);
    return APPLIED;
  }

  private async applyPlan(
    trx: DbTransaction,
    program: Program,
    plan: ReconciliationPlan,
    message: ProgramSnapshot,
  ): Promise<void> {
    const limitChanged = plan.limitMinor !== program.limitMinor;
    if (!limitChanged && plan.changes.length === 0) {
      return;
    }
    const reservationIds = await this.writeChanges(trx, program, plan.changes);
    const entries: NewLedgerEntry[] = [];
    if (limitChanged) {
      entries.push(
        ledger({ ...program, limitMinor: plan.limitMinor }, message.messageId, {
          type: 'LIMIT_SET',
          delta_minor: plan.limitMinor - program.limitMinor,
          reason: 'SNAPSHOT_LIMIT',
        }),
      );
    }
    let utilised = program.utilisedMinor;
    for (const change of plan.changes) {
      utilised += change.deltaMinor;
      entries.push(
        ledger(
          { ...program, limitMinor: plan.limitMinor, utilisedMinor: utilised },
          message.messageId,
          {
            type: 'RECONCILE_ADJUST',
            delta_minor: change.deltaMinor,
            reason: change.reason,
            reservation_id: reservationIds.get(invoiceIdOf(change)) ?? null,
          },
        ),
      );
    }
    await this.capacity.updateProgram(trx, program, {
      limitMinor: plan.limitMinor,
      utilisedMinor: plan.utilisedAfterMinor,
    });
    await this.capacity.appendLedger(trx, entries);
  }

  private async writeChanges(
    trx: DbTransaction,
    program: Program,
    changes: readonly ReconciliationChange[],
  ): Promise<Map<string, string>> {
    const imports: NewReservation[] = [];
    const rebooks: ReservationRebook[] = [];
    for (const change of changes) {
      if (change.kind === 'import') {
        imports.push({
          programId: program.id,
          invoiceId: change.entry.invoiceId,
          status: change.status,
          origin: 'TREASURY',
          invoiceAmountMinor: change.entry.invoiceAmountMinor,
          invoiceCurrency: change.entry.invoiceCurrency,
          invoiceReleasedMinor: change.invoiceReleasedMinor,
          bookedMinor: change.entry.bookedMinor,
          fx: null,
        });
        continue;
      }
      rebooks.push({
        id: change.reservation.id,
        status: change.status,
        invoiceReleasedMinor: change.invoiceReleasedAfterMinor,
        bookedMinor: change.bookedAfterMinor,
        releasedMinor: change.releasedAfterMinor,
        allocationBase: change.allocationBase,
      });
    }
    await this.capacity.rebookReservations(trx, rebooks);
    const ids = await this.capacity.insertReservations(trx, imports);
    for (const change of changes) {
      if (change.kind === 'adjust') {
        ids.set(change.reservation.invoiceId, change.reservation.id);
      }
    }
    return ids;
  }

  private async createProgram(
    trx: DbTransaction,
    message: ProgramLimitSet | ProgramSnapshot,
    limitMinor: bigint,
  ): Promise<Program> {
    const program = await this.capacity.insertProgram(trx, {
      id: message.programId,
      currency: message.currency,
      limitMinor,
    });
    await this.capacity.appendLedger(trx, [
      ledger(program, message.messageId, {
        type: 'LIMIT_SET',
        delta_minor: limitMinor,
        reason: 'PROGRAM_CREATED',
      }),
    ]);
    return program;
  }
}

function fingerprintOf(rawValue: string): Buffer {
  return createHash('sha256').update(rawValue, 'utf8').digest();
}

function classify(parsed: ReadableTreasuryMessage): MessageClass {
  if (parsed.message === null) {
    return 'INVALID';
  }
  if (parsed.message.type === TreasuryMessageType.ProgramSnapshot) {
    return 'SNAPSHOT';
  }
  return 'DELTA';
}

function pendingLimit(message: ProgramLimitSet): PendingLimit {
  return { limitMinor: message.limit, currency: message.currency };
}

function processed(
  inbound: InboundTreasuryMessage,
  fingerprint: Buffer,
  outcome: 'APPLIED' | 'PARKED' | 'STALE',
  reason: string | null,
) {
  const { envelope } = inbound.parsed;
  return {
    messageId: envelope.messageId,
    programId: envelope.programId,
    revision: BigInt(envelope.revision),
    type: envelope.type,
    fingerprint,
    outcome,
    reason,
    source: inbound.source,
  };
}

function ledger(
  program: Program,
  messageId: string,
  entry: Pick<NewLedgerEntry, 'type' | 'delta_minor' | 'reason'> &
    Partial<Pick<NewLedgerEntry, 'reservation_id'>>,
): NewLedgerEntry {
  return {
    program_id: program.id,
    reservation_id: null,
    utilised_after_minor: program.utilisedMinor,
    limit_after_minor: program.limitMinor,
    actor: TREASURY_ACTOR,
    correlation_id: null,
    source_message_id: messageId,
    ...entry,
  };
}

function invoiceIdOf(change: ReconciliationChange): string {
  return change.kind === 'import' ? change.entry.invoiceId : change.reservation.invoiceId;
}

function virtualProgram(message: ProgramSnapshot): Program {
  return {
    id: message.programId,
    currency: message.currency,
    limitMinor: message.limit,
    utilisedMinor: 0n,
    version: 0n,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}
