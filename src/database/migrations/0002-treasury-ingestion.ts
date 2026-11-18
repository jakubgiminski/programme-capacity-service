import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE processed_messages (
      message_id text PRIMARY KEY,
      program_id text NOT NULL,
      revision bigint NOT NULL,
      type text NOT NULL,
      outcome text NOT NULL
        CHECK (outcome IN ('APPLIED', 'PARKED', 'STALE', 'REJECTED', 'SUPERSEDED')),
      reason text,
      source_topic text NOT NULL,
      source_partition integer NOT NULL,
      source_offset text NOT NULL,
      received_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);

  await sql`
    CREATE TABLE pending_treasury_messages (
      message_id text PRIMARY KEY REFERENCES processed_messages (message_id),
      program_id text NOT NULL,
      revision bigint NOT NULL CHECK (revision > 0),
      raw_value text NOT NULL,
      source_topic text NOT NULL,
      source_partition integer NOT NULL,
      source_offset text NOT NULL,
      received_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pending_treasury_messages_program_revision_unique UNIQUE (program_id, revision)
    )
  `.execute(db);

  await sql`
    CREATE TABLE treasury_dead_letters (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      message_id text,
      program_id text,
      revision bigint,
      reason text NOT NULL,
      raw_value text NOT NULL,
      source_topic text NOT NULL,
      source_partition integer NOT NULL,
      source_offset text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      published_at timestamptz
    )
  `.execute(db);

  await sql`
    CREATE INDEX treasury_dead_letters_unpublished
      ON treasury_dead_letters (id) WHERE published_at IS NULL
  `.execute(db);

  await sql`
    CREATE TABLE reconciliation_discrepancies (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      program_id text NOT NULL REFERENCES programs (id),
      invoice_id text NOT NULL,
      kind text NOT NULL CHECK (
        kind IN ('TREASURY_AMOUNT_LOWER', 'MISSING_FROM_SNAPSHOT', 'RELEASED_LOCALLY', 'INVOICE_MISMATCH')
      ),
      local_status text,
      local_outstanding_minor bigint,
      treasury_outstanding_minor bigint,
      detail text,
      snapshot_message_id text NOT NULL,
      snapshot_revision bigint NOT NULL,
      detected_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      resolved_at timestamptz
    )
  `.execute(db);

  await sql`
    CREATE UNIQUE INDEX reconciliation_discrepancies_open_unique
      ON reconciliation_discrepancies (program_id, invoice_id, kind) WHERE resolved_at IS NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE reconciliation_discrepancies`.execute(db);
  await sql`DROP TABLE treasury_dead_letters`.execute(db);
  await sql`DROP TABLE pending_treasury_messages`.execute(db);
  await sql`DROP TABLE processed_messages`.execute(db);
}
