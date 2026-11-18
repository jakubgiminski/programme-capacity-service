import { Injectable } from '@nestjs/common';
import { type Kysely, sql } from 'kysely';
import { type Database, type MessageOutcome } from '../../database/database.types';
import { type Discrepancy, type DiscrepancyKind } from '../domain/reconciliation';

type Executor = Kysely<Database>;

export interface MessageSource {
  readonly topic: string;
  readonly partition: number;
  readonly offset: string;
}

export interface ProcessedMessage {
  readonly messageId: string;
  readonly programId: string;
  readonly revision: bigint;
  readonly type: string;
  readonly outcome: MessageOutcome;
  readonly reason: string | null;
  readonly source: MessageSource;
}

export interface PendingMessage {
  readonly messageId: string;
  readonly programId: string;
  readonly revision: bigint;
  readonly rawValue: string;
  readonly source: MessageSource;
}

export interface DeadLetter {
  readonly messageId: string | null;
  readonly programId: string | null;
  readonly revision: bigint | null;
  readonly reason: string;
  readonly rawValue: string;
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

export interface SnapshotReference {
  readonly messageId: string;
  readonly revision: bigint;
}

@Injectable()
export class TreasuryRepository {
  async lockProgramStream(db: Executor, programId: string): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${programId}, 0))`.execute(db);
  }

  async isProcessed(db: Executor, messageId: string): Promise<boolean> {
    const row = await db
      .selectFrom('processed_messages')
      .select('message_id')
      .where('message_id', '=', messageId)
      .executeTakeFirst();
    return row !== undefined;
  }

  async recordProcessed(db: Executor, message: ProcessedMessage): Promise<void> {
    await db
      .insertInto('processed_messages')
      .values({
        message_id: message.messageId,
        program_id: message.programId,
        revision: message.revision,
        type: message.type,
        outcome: message.outcome,
        reason: message.reason,
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
      .set({ outcome, reason, updated_at: new Date() })
      .where('message_id', '=', messageId)
      .execute();
  }

  async park(db: Executor, message: PendingMessage): Promise<boolean> {
    const result = await db
      .insertInto('pending_treasury_messages')
      .values({
        message_id: message.messageId,
        program_id: message.programId,
        revision: message.revision,
        raw_value: message.rawValue,
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
      .returning('message_id')
      .execute();
    if (removed.length === 0) {
      return 0;
    }
    await db
      .updateTable('processed_messages')
      .set({
        outcome: 'SUPERSEDED',
        reason: `Covered by snapshot revision ${upToRevision}`,
        updated_at: new Date(),
      })
      .where(
        'message_id',
        'in',
        removed.map((row) => row.message_id),
      )
      .execute();
    return removed.length;
  }

  async addDeadLetter(db: Executor, deadLetter: DeadLetter): Promise<void> {
    await db
      .insertInto('treasury_dead_letters')
      .values({
        message_id: deadLetter.messageId,
        program_id: deadLetter.programId,
        revision: deadLetter.revision,
        reason: deadLetter.reason,
        raw_value: deadLetter.rawValue,
        source_topic: deadLetter.source.topic,
        source_partition: deadLetter.source.partition,
        source_offset: deadLetter.source.offset,
      })
      .execute();
  }

  async setTreasuryRevision(db: Executor, programId: string, revision: bigint): Promise<void> {
    await db
      .updateTable('programs')
      .set({ treasury_revision: revision })
      .where('id', '=', programId)
      .execute();
  }

  async recordDiscrepancies(
    db: Executor,
    programId: string,
    discrepancies: readonly Discrepancy[],
    snapshot: SnapshotReference,
  ): Promise<void> {
    const now = new Date();
    for (const discrepancy of discrepancies) {
      const values = {
        local_status: discrepancy.localStatus,
        local_outstanding_minor: discrepancy.localOutstandingMinor,
        treasury_outstanding_minor: discrepancy.treasuryOutstandingMinor,
        detail: discrepancy.detail,
        snapshot_message_id: snapshot.messageId,
        snapshot_revision: snapshot.revision,
        last_seen_at: now,
      };
      const updated = await db
        .updateTable('reconciliation_discrepancies')
        .set(values)
        .where('program_id', '=', programId)
        .where('invoice_id', '=', discrepancy.invoiceId)
        .where('kind', '=', discrepancy.kind)
        .where('resolved_at', 'is', null)
        .executeTakeFirst();
      if (updated.numUpdatedRows > 0n) {
        continue;
      }
      await db
        .insertInto('reconciliation_discrepancies')
        .values({
          ...values,
          program_id: programId,
          invoice_id: discrepancy.invoiceId,
          kind: discrepancy.kind,
        })
        .execute();
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

  async listOpenDiscrepancies(db: Executor, programId: string): Promise<OpenDiscrepancy[]> {
    const rows = await db
      .selectFrom('reconciliation_discrepancies')
      .selectAll()
      .where('program_id', '=', programId)
      .where('resolved_at', 'is', null)
      .orderBy('invoice_id')
      .orderBy('kind')
      .execute();
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
