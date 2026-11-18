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
  type TreasuryEnvelope,
} from '../../treasury/treasury-messages';
import { CapacityError } from '../domain/errors';
import { type Program } from '../domain/model';
import { decideOrdering } from '../domain/ordering';
import { planReconciliation, type ReconciliationPlan } from '../domain/reconciliation';
import { CapacityRepository } from '../infrastructure/capacity.repository';
import { type MessageSource, TreasuryRepository } from '../infrastructure/treasury.repository';
import { ReleaseProcessor } from './release-processor';

export const TREASURY_ACTOR = 'treasury';

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

type ApplyResult = { applied: true } | { applied: false; reason: string };

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

  execute(inbound: InboundTreasuryMessage): Promise<ApplyTreasuryResult> {
    const { envelope } = inbound.parsed;
    return this.db.transaction().execute(async (trx) => {
      await this.treasury.lockProgramStream(trx, envelope.programId);
      if (await this.treasury.isProcessed(trx, envelope.messageId)) {
        return { outcome: 'DUPLICATE', reason: null, drained: 0, deadLettered: 0 };
      }

      const program = await this.capacity.lockProgram(trx, envelope.programId);
      const current = program?.treasuryRevision ?? 0n;
      const revision = BigInt(envelope.revision);
      const isValidSnapshot = inbound.parsed.message?.type === TreasuryMessageType.ProgramSnapshot;
      const decision = decideOrdering(current, revision, isValidSnapshot);

      if (decision === 'STALE') {
        const reason = `Revision ${revision} is not newer than applied revision ${current}`;
        await this.treasury.recordProcessed(trx, processed(inbound, 'STALE', reason));
        return { outcome: 'STALE', reason, drained: 0, deadLettered: 0 };
      }

      if (decision === 'PARK') {
        return this.park(trx, inbound, current);
      }

      await this.treasury.recordProcessed(trx, processed(inbound, 'APPLIED', null));
      const result = await this.applyOne(trx, program, inbound.parsed);
      let deadLettered = 0;
      if (!result.applied) {
        await this.reject(trx, envelope, inbound.rawValue, inbound.source, result.reason);
        deadLettered += 1;
      }
      const drain = await this.drain(trx, envelope.programId);
      return {
        outcome: result.applied ? 'APPLIED' : 'REJECTED',
        reason: result.applied ? null : result.reason,
        drained: drain.drained,
        deadLettered: deadLettered + drain.deadLettered,
      };
    });
  }

  private async park(
    trx: DbTransaction,
    inbound: InboundTreasuryMessage,
    current: bigint,
  ): Promise<ApplyTreasuryResult> {
    const { envelope } = inbound.parsed;
    const reason = `Waiting for revision ${current + 1n}`;
    await this.treasury.recordProcessed(trx, processed(inbound, 'PARKED', reason));
    const parked = await this.treasury.park(trx, {
      messageId: envelope.messageId,
      programId: envelope.programId,
      revision: BigInt(envelope.revision),
      rawValue: inbound.rawValue,
      source: inbound.source,
    });
    if (parked) {
      return { outcome: 'PARKED', reason, drained: 0, deadLettered: 0 };
    }
    const conflict = `Another message is already parked for revision ${envelope.revision}`;
    await this.reject(trx, envelope, inbound.rawValue, inbound.source, conflict);
    return { outcome: 'REJECTED', reason: conflict, drained: 0, deadLettered: 1 };
  }

  private async drain(
    trx: DbTransaction,
    programId: string,
  ): Promise<{ drained: number; deadLettered: number }> {
    let drained = 0;
    let deadLettered = 0;
    for (;;) {
      const program = await this.capacity.lockProgram(trx, programId);
      if (program === null) {
        return { drained, deadLettered };
      }
      const next = await this.treasury.takePending(trx, programId, program.treasuryRevision + 1n);
      if (next === null) {
        return { drained, deadLettered };
      }
      const parsed = parseTreasuryMessage(next.rawValue);
      if (parsed.kind === 'unreadable') {
        throw new Error(`Parked message ${next.messageId} is unreadable`);
      }
      const result = await this.applyOne(trx, program, parsed);
      drained += 1;
      if (result.applied) {
        await this.treasury.updateOutcome(trx, next.messageId, 'APPLIED', null);
        continue;
      }
      await this.reject(trx, parsed.envelope, next.rawValue, next.source, result.reason);
      deadLettered += 1;
    }
  }

  private async reject(
    trx: DbTransaction,
    envelope: TreasuryEnvelope,
    rawValue: string,
    source: MessageSource,
    reason: string,
  ): Promise<void> {
    await this.treasury.updateOutcome(trx, envelope.messageId, 'REJECTED', reason);
    await this.treasury.addDeadLetter(trx, {
      messageId: envelope.messageId,
      programId: envelope.programId,
      revision: BigInt(envelope.revision),
      reason,
      rawValue,
      source,
    });
  }

  private async applyOne(
    trx: DbTransaction,
    program: Program | null,
    parsed: ReadableTreasuryMessage,
  ): Promise<ApplyResult> {
    const revision = BigInt(parsed.envelope.revision);
    const result = await this.dispatch(trx, program, parsed);
    if (!result.applied && program !== null && revision === program.treasuryRevision + 1n) {
      await this.treasury.setTreasuryRevision(trx, program.id, revision);
    }
    return result;
  }

  private async dispatch(
    trx: DbTransaction,
    program: Program | null,
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
      return await this.reconcile(trx, program, message);
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
    const revision = BigInt(message.revision);
    if (program === null) {
      await this.createProgram(trx, message, message.limit, revision);
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
      treasuryRevision: revision,
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
    await this.treasury.setTreasuryRevision(trx, program.id, BigInt(message.revision));
    return APPLIED;
  }

  private async reconcile(
    trx: DbTransaction,
    existing: Program | null,
    message: ProgramSnapshot,
  ): Promise<ApplyResult> {
    if (existing !== null && existing.currency !== message.currency) {
      return rejected(
        `Programme currency ${existing.currency} cannot change to ${message.currency}`,
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
        bookedMinor: entry.bookedAmount,
      })),
    });
    const program = existing ?? (await this.createProgram(trx, message, message.limit, revision));
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
    const revision = BigInt(message.revision);
    const limitChanged = plan.limitMinor !== program.limitMinor;
    if (!limitChanged && plan.changes.length === 0) {
      await this.treasury.setTreasuryRevision(trx, program.id, revision);
      return;
    }
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
      const reservationId = await this.applyChange(trx, program, change);
      utilised += change.deltaMinor;
      entries.push(
        ledger(
          { ...program, limitMinor: plan.limitMinor, utilisedMinor: utilised },
          message.messageId,
          {
            type: 'RECONCILE_ADJUST',
            delta_minor: change.deltaMinor,
            reason: change.reason,
            reservation_id: reservationId,
          },
        ),
      );
    }
    await this.capacity.updateProgram(trx, program, {
      limitMinor: plan.limitMinor,
      utilisedMinor: plan.utilisedAfterMinor,
      treasuryRevision: revision,
    });
    await this.capacity.appendLedger(trx, entries);
  }

  private async applyChange(
    trx: DbTransaction,
    program: Program,
    change: ReconciliationPlan['changes'][number],
  ): Promise<string> {
    if (change.kind === 'import') {
      const reservation = await this.capacity.insertReservation(trx, {
        programId: program.id,
        invoiceId: change.entry.invoiceId,
        origin: 'TREASURY',
        invoiceAmountMinor: change.entry.invoiceAmountMinor,
        invoiceCurrency: change.entry.invoiceCurrency,
        bookedMinor: change.entry.bookedMinor,
        fx: null,
      });
      return reservation.id;
    }
    await this.capacity.updateReservation(trx, change.reservation.id, {
      status: change.status,
      invoiceReleasedMinor: change.invoiceReleasedAfterMinor,
      bookedMinor: change.bookedAfterMinor,
      releasedMinor: change.releasedAfterMinor,
    });
    return change.reservation.id;
  }

  private async createProgram(
    trx: DbTransaction,
    message: ProgramLimitSet | ProgramSnapshot,
    limitMinor: bigint,
    revision: bigint,
  ): Promise<Program> {
    const program = await this.capacity.insertProgram(trx, {
      id: message.programId,
      currency: message.currency,
      limitMinor,
      treasuryRevision: revision,
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

function processed(
  inbound: InboundTreasuryMessage,
  outcome: 'APPLIED' | 'PARKED' | 'STALE',
  reason: string | null,
) {
  const { envelope } = inbound.parsed;
  return {
    messageId: envelope.messageId,
    programId: envelope.programId,
    revision: BigInt(envelope.revision),
    type: envelope.type,
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

function virtualProgram(message: ProgramSnapshot): Program {
  return {
    id: message.programId,
    currency: message.currency,
    limitMinor: message.limit,
    utilisedMinor: 0n,
    version: 0n,
    treasuryRevision: 0n,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}
