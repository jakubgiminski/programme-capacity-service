import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE programs (
      id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'),
      currency char(3) NOT NULL,
      limit_minor bigint NOT NULL CHECK (limit_minor >= 0),
      utilised_minor bigint NOT NULL DEFAULT 0 CHECK (utilised_minor >= 0),
      version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);

  await sql`
    CREATE FUNCTION forbid_program_currency_change() RETURNS trigger AS $$
    BEGIN
      IF NEW.currency <> OLD.currency THEN
        RAISE EXCEPTION 'programme currency is immutable' USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  await sql`
    CREATE TRIGGER programs_currency_immutable
      BEFORE UPDATE OF currency ON programs
      FOR EACH ROW EXECUTE FUNCTION forbid_program_currency_change()
  `.execute(db);

  await sql`
    CREATE TABLE reservations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      program_id text NOT NULL REFERENCES programs (id),
      invoice_id text NOT NULL CHECK (invoice_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'),
      status text NOT NULL CHECK (status IN ('ACTIVE', 'PARTIALLY_RELEASED', 'RELEASED')),
      origin text NOT NULL CHECK (origin IN ('API', 'TREASURY')),
      invoice_amount_minor bigint NOT NULL CHECK (invoice_amount_minor > 0),
      invoice_currency char(3) NOT NULL,
      invoice_released_minor bigint NOT NULL DEFAULT 0
        CHECK (invoice_released_minor >= 0 AND invoice_released_minor <= invoice_amount_minor),
      booked_minor bigint NOT NULL CHECK (booked_minor > 0),
      released_minor bigint NOT NULL DEFAULT 0
        CHECK (released_minor >= 0 AND released_minor <= booked_minor),
      allocation_base_invoice_minor bigint NOT NULL DEFAULT 0
        CHECK (allocation_base_invoice_minor >= 0 AND allocation_base_invoice_minor <= invoice_released_minor),
      allocation_base_released_minor bigint NOT NULL DEFAULT 0
        CHECK (allocation_base_released_minor >= 0 AND allocation_base_released_minor <= released_minor),
      fx_rate bigint CHECK (fx_rate > 0),
      fx_scale smallint CHECK (fx_scale >= 0),
      fx_source text,
      fx_as_of timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT reservations_program_invoice_unique UNIQUE (program_id, invoice_id),
      CONSTRAINT reservations_released_when_invoice_repaid
        CHECK ((status = 'RELEASED') = (invoice_released_minor = invoice_amount_minor)),
      CONSTRAINT reservations_released_frees_booking
        CHECK (status <> 'RELEASED' OR released_minor = booked_minor),
      CONSTRAINT reservations_fx_snapshot_complete
        CHECK (
          (fx_rate IS NULL AND fx_scale IS NULL AND fx_source IS NULL AND fx_as_of IS NULL)
          OR (fx_rate IS NOT NULL AND fx_scale IS NOT NULL AND fx_source IS NOT NULL AND fx_as_of IS NOT NULL)
        ),
      CONSTRAINT reservations_api_has_fx_snapshot CHECK (origin <> 'API' OR fx_rate IS NOT NULL)
    )
  `.execute(db);

  await sql`
    CREATE INDEX reservations_open_by_program
      ON reservations (program_id) WHERE status <> 'RELEASED'
  `.execute(db);

  await sql`
    CREATE TABLE releases (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      reservation_id uuid NOT NULL REFERENCES reservations (id),
      release_id text NOT NULL CHECK (release_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'),
      requested_invoice_amount_minor bigint CHECK (requested_invoice_amount_minor > 0),
      invoice_amount_minor bigint NOT NULL CHECK (invoice_amount_minor > 0),
      freed_minor bigint NOT NULL CHECK (freed_minor >= 0),
      origin text NOT NULL CHECK (origin IN ('API', 'TREASURY')),
      actor text NOT NULL,
      sequence bigint NOT NULL CHECK (sequence > 0),
      status_after text NOT NULL CHECK (status_after IN ('PARTIALLY_RELEASED', 'RELEASED')),
      invoice_released_after_minor bigint NOT NULL CHECK (invoice_released_after_minor > 0),
      booked_after_minor bigint NOT NULL CHECK (booked_after_minor > 0),
      released_after_minor bigint NOT NULL CHECK (released_after_minor >= 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT releases_reservation_release_unique UNIQUE (reservation_id, release_id),
      CONSTRAINT releases_reservation_sequence_unique UNIQUE (reservation_id, sequence)
    )
  `.execute(db);

  await sql`
    CREATE TABLE ledger_entries (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      type text NOT NULL CHECK (type IN ('RESERVE', 'RELEASE', 'LIMIT_SET', 'RECONCILE_ADJUST')),
      program_id text NOT NULL REFERENCES programs (id),
      reservation_id uuid REFERENCES reservations (id),
      delta_minor bigint NOT NULL,
      utilised_after_minor bigint NOT NULL,
      limit_after_minor bigint NOT NULL,
      actor text NOT NULL,
      correlation_id text,
      source_message_id text,
      reason text,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);

  await sql`CREATE INDEX ledger_entries_by_program ON ledger_entries (program_id, id)`.execute(db);

  await sql`
    CREATE FUNCTION forbid_ledger_mutation() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'ledger_entries is append-only' USING ERRCODE = 'insufficient_privilege';
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  await sql`
    CREATE TRIGGER ledger_entries_append_only
      BEFORE UPDATE OR DELETE OR TRUNCATE ON ledger_entries
      FOR EACH STATEMENT EXECUTE FUNCTION forbid_ledger_mutation()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE ledger_entries`.execute(db);
  await sql`DROP FUNCTION forbid_ledger_mutation`.execute(db);
  await sql`DROP TABLE releases`.execute(db);
  await sql`DROP TABLE reservations`.execute(db);
  await sql`DROP TABLE programs`.execute(db);
  await sql`DROP FUNCTION forbid_program_currency_change`.execute(db);
}
