import { Injectable } from '@nestjs/common';
import { type Kysely, sql } from 'kysely';
import { type Database, type MessageOutcome } from '../../database/database.types';
import { type CurrencyCode } from '../../money';
import { type Program } from '../domain/model';
import { type Discrepancy, type DiscrepancyKind } from '../domain/reconciliation';

type Executor = Kysely<Database>;

export interface MessageSource {
  readonly topic: string;
  readonly partition: number;
  readonly offset: string;
}

export interface StreamPosition {
  readonly revision: bigint;
  readonly snapshotAsOf: Date | null;
}

export interface StreamStatus {
  readonly revision: bigint;
  readonly parkedMessages: number;
  readonly oldestParkedAt: Date | null;
  readonly pendingLimitMinor: bigint | null;
}

export interface ProcessedMessage {
  readonly messageId: string;
  readonly programId: string;
  readonly revision: bigint;
  readonly type: string;
  readonly fingerprint: Buffer;
  readonly outcome: MessageOutcome;
  readonly reason: string | null;
  readonly source: MessageSource;
}

export interface PendingLimit {
  readonly limitMinor: bigint;
  readonly currency: CurrencyCode;
}

export interface PendingMessage {
  readonly messageId: string;
  readonly programId: string;
  readonly revision: bigint;
  readonly rawValue: string;
  readonly rejected: boolean;
  readonly source: MessageSource;
}

export interface NewPendingMessage extends PendingMessage {
  readonly limit: PendingLimit | null;
}

export interface DeadLetter {
  readonly messageId: string | null;
  readonly programId: string | null;
  readonly revision: bigint | null;
  readonly reason: string;
  readonly key: Buffer | null;
  readonly payload: Buffer | null;
  readonly source: MessageSource;
}

export interface OpenDiscrepancy {
  readonly id: string;
  readonly programId: string;
  readonly invoiceId: string;
  readonly kind: DiscrepancyKind;
  readonly localStatus: string | null;
  readonly localOutstandingMinor: bigint | null;
  readonly treasuryOutstandingMinor: bigint | null;
  readonly detail: string | null;
  readonly snapshotMessageId: string;
  readonly snapshotRevision: bigint;
  readonly detectedAt: Date;
  readonly lastSeenAt: Date;
}

export interface DiscrepancyCursor {
  readonly invoiceId: string;
  readonly kind: DiscrepancyKind;
}

export interface DiscrepancyPage {
  readonly limit: number;
  readonly after: DiscrepancyCursor | null;
}

export interface SnapshotReference {
  readonly messageId: string;
  readonly revision: bigint;
}

export function storableText(text: string): string {
  return text.replaceAll('\u0000', '\uFFFD');
}

@Injectable()
export class TreasuryRepository {
  async lockStream(db: Executor, programId: string): Promise<StreamPosition> {
    await db
      .insertInto('treasury_streams')
      .values({ program_id: programId })
      .onConflict((conflict) => conflict.column('program_id').doNothing())
      .execute();
    const row = await db
      .selectFrom('treasury_streams')
      .select(['revision', 'snapshot_as_of'])
      .where('program_id', '=', programId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    return { revision: row.revision, snapshotAsOf: row.snapshot_as_of };
  }

  async setStreamRevision(
    db: Executor,
    programId: string,
    revision: bigint,
    snapshotAsOf?: Date,
  ): Promise<void> {
    await db
      .updateTable('treasury_streams')
      .set({
        revision,
        ...(snapshotAsOf === undefined ? {} : { snapshot_as_of: snapshotAsOf }),
        updated_at: new Date(),
      })
      .where('program_id', '=', programId)
      .execute();
  }

  async streamStatus(db: Executor, program: Program): Promise<StreamStatus> {
    const stream = await db
      .selectFrom('treasury_streams')
      .select('revision')
      .where('program_id', '=', program.id)
      .executeTakeFirst();
    const parked = await db
      .selectFrom('pending_treasury_messages')
      .select((eb) => [eb.fn.countAll<bigint>().as('count'), eb.fn.min('received_at').as('oldest')])
      .where('program_id', '=', program.id)
      .executeTakeFirstOrThrow();
    return {
      revision: stream?.revision ?? 0n,
      parkedMessages: Number(parked.count),
      oldestParkedAt: parked.oldest,
      pendingLimitMinor: await this.lowestPendingLimit(db, program),
    };
  }

  async lowestPendingLimit(db: Executor, program: Program): Promise<bigint | null> {
    const row = await db
      .selectFrom('pending_treasury_messages')
      .select((eb) => eb.fn.min('limit_minor').as('limit'))
      .where('program_id', '=', program.id)
      .where('limit_currency', '=', program.currency)
      .executeTakeFirstOrThrow();
    return row.limit;
  }

  async findFingerprint(db: Executor, messageId: string): Promise<Buffer | null> {
    const row = await db
      .selectFrom('processed_messages')
      .select('fingerprint')
      .where('message_id', '=', messageId)
      .executeTakeFirst();
    return row?.fingerprint ?? null;
  }

  async recordProcessed(db: Executor, message: ProcessedMessage): Promise<void> {
    await db
      .insertInto('processed_messages')
      .values({
        message_id: message.messageId,
        program_id: message.programId,
        revision: message.revision,
        type: message.type,
        fingerprint: message.fingerprint,
        outcome: message.outcome,
        reason: message.reason === null ? null : storableText(message.reason),
        source_topic: message.source.topic,
        source_partition: message.source.partition,
        source_offset: message.source.offset,
      })
      .execute();
  }

  async updateOutcome(
    db: Executor,
    messageId: string,
    outcome: MessageOutcome,
    reason: string | null,
  ): Promise<void> {
    await db
      .updateTable('processed_messages')
      .set({
        outcome,
        reason: reason === null ? null : storableText(reason),
        updated_at: new Date(),
      })
      .where('message_id', '=', messageId)
      .execute();
  }

  async park(db: Executor, message: NewPendingMessage): Promise<boolean> {
    const result = await db
      .insertInto('pending_treasury_messages')
      .values({
        message_id: message.messageId,
        program_id: message.programId,
        revision: message.revision,
        raw_value: message.rawValue,
        rejected: message.rejected,
        limit_minor: message.limit?.limitMinor ?? null,
        limit_currency: message.limit?.currency ?? null,
        source_topic: message.source.topic,
        source_partition: message.source.partition,
        source_offset: message.source.offset,
      })
      .onConflict((conflict) => conflict.columns(['program_id', 'revision']).doNothing())
      .executeTakeFirst();
    return result.numInsertedOrUpdatedRows === 1n;
  }

  async takePending(
    db: Executor,
    programId: string,
    revision: bigint,
  ): Promise<PendingMessage | null> {
    const row = await db
      .deleteFrom('pending_treasury_messages')
      .where('program_id', '=', programId)
      .where('revision', '=', revision)
      .returningAll()
      .executeTakeFirst();
    if (row === undefined) {
      return null;
    }
    return {
      messageId: row.message_id,
      programId: row.program_id,
      revision: row.revision,
      rawValue: row.raw_value,
      rejected: row.rejected,
      source: {
        topic: row.source_topic,
        partition: row.source_partition,
        offset: row.source_offset,
      },
    };
  }

  async supersedePending(db: Executor, programId: string, upToRevision: bigint): Promise<number> {
    const removed = await db
      .deleteFrom('pending_treasury_messages')
      .where('program_id', '=', programId)
      .where('revision', '<=', upToRevision)
      .returning(['message_id', 'rejected'])
      .execute();
    const superseded = removed.filter((row) => !row.rejected);
    if (superseded.length === 0) {
      return 0;
    }
    await db
      .updateTable('processed_messages')
      .set({
        outcome: 'SUPERSEDED',
        reason: `Covered by snapshot revision ${upToRevision}`,
        updated_at: new Date(),
      })
      .where(sql<boolean>`message_id = any(${superseded.map((row) => row.message_id)}::text[])`)
      .execute();
    return superseded.length;
  }

  async addDeadLetter(db: Executor, deadLetter: DeadLetter): Promise<boolean> {
    const result = await db
      .insertInto('treasury_dead_letters')
      .values({
        message_id: deadLetter.messageId,
        program_id: deadLetter.programId,
        revision: deadLetter.revision,
        reason: storableText(deadLetter.reason),
        message_key: deadLetter.key,
        payload: deadLetter.payload,
        source_topic: deadLetter.source.topic,
        source_partition: deadLetter.source.partition,
        source_offset: deadLetter.source.offset,
      })
      .onConflict((conflict) =>
        conflict.columns(['source_topic', 'source_partition', 'source_offset']).doNothing(),
      )
      .executeTakeFirst();
    return result.numInsertedOrUpdatedRows === 1n;
  }

  async recordDiscrepancies(
    db: Executor,
    programId: string,
    discrepancies: readonly Discrepancy[],
    snapshot: SnapshotReference,
  ): Promise<void> {
    const now = new Date();
    if (discrepancies.length > 0) {
      const column = <T>(read: (discrepancy: Discrepancy) => T) => discrepancies.map(read);
      await sql`
        INSERT INTO reconciliation_discrepancies (
          program_id, invoice_id, kind, local_status, local_outstanding_minor,
          treasury_outstanding_minor, detail, snapshot_message_id, snapshot_revision,
          detected_at, last_seen_at
        )
        SELECT
          ${programId}, v.invoice_id, v.kind, v.local_status, v.local_outstanding_minor,
          v.treasury_outstanding_minor, v.detail, ${snapshot.messageId}, ${snapshot.revision},
          ${now}, ${now}
        FROM unnest(
          ${column((item) => item.invoiceId)}::text[],
          ${column((item) => item.kind)}::text[],
          ${column((item) => item.localStatus)}::text[],
          ${column((item) => item.localOutstandingMinor.toString())}::bigint[],
          ${column((item) => item.treasuryOutstandingMinor?.toString() ?? null)}::bigint[],
          ${column((item) => storableText(item.detail))}::text[]
        ) AS v(
          invoice_id, kind, local_status, local_outstanding_minor,
          treasury_outstanding_minor, detail
        )
        ON CONFLICT (program_id, invoice_id, kind) WHERE resolved_at IS NULL
        DO UPDATE SET
          local_status = excluded.local_status,
          local_outstanding_minor = excluded.local_outstanding_minor,
          treasury_outstanding_minor = excluded.treasury_outstanding_minor,
          detail = excluded.detail,
          snapshot_message_id = excluded.snapshot_message_id,
          snapshot_revision = excluded.snapshot_revision,
          last_seen_at = excluded.last_seen_at
      `.execute(db);
    }
    await db
      .updateTable('reconciliation_discrepancies')
      .set({ resolved_at: now })
      .where('program_id', '=', programId)
      .where('resolved_at', 'is', null)
      .where('snapshot_revision', '<>', snapshot.revision)
      .execute();
  }

  async countOpenDiscrepancies(db: Executor, programId: string): Promise<number> {
    const row = await db
      .selectFrom('reconciliation_discrepancies')
      .select((eb) => eb.fn.countAll<bigint>().as('count'))
      .where('program_id', '=', programId)
      .where('resolved_at', 'is', null)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  async listOpenDiscrepancies(
    db: Executor,
    programId: string,
    page: DiscrepancyPage,
  ): Promise<OpenDiscrepancy[]> {
    const { after } = page;
    let query = db
      .selectFrom('reconciliation_discrepancies')
      .selectAll()
      .where('program_id', '=', programId)
      .where('resolved_at', 'is', null);
    if (after !== null) {
      query = query.where((eb) =>
        eb(eb.refTuple('invoice_id', 'kind'), '>', eb.tuple(after.invoiceId, after.kind)),
      );
    }
    const rows = await query.orderBy('invoice_id').orderBy('kind').limit(page.limit).execute();
    return rows.map((row) => ({
      id: row.id,
      programId: row.program_id,
      invoiceId: row.invoice_id,
      kind: row.kind,
      localStatus: row.local_status,
      localOutstandingMinor: row.local_outstanding_minor,
      treasuryOutstandingMinor: row.treasury_outstanding_minor,
      detail: row.detail,
      snapshotMessageId: row.snapshot_message_id,
      snapshotRevision: row.snapshot_revision,
      detectedAt: row.detected_at,
      lastSeenAt: row.last_seen_at,
    }));
  }
}
