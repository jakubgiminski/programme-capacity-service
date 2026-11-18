# Implementation Plan

Service that tracks a financing program's credit capacity in real time: invoice reservations, releases (full and partial), current availability, and treasury data ingested from Kafka including bulk reconciliation snapshots. See [SPEC.md](SPEC.md) for the original brief.

## 1. Guiding principles

- Money is never a float. All amounts are integer ISO 4217 minor units (`bigint` in TypeScript, `BIGINT` in Postgres).
- Fail-safe over permissive: whenever the system is unsure, it keeps capacity reserved rather than freeing it. Under-lending is recoverable, over-lending is credit risk.
- Every state change is atomic, idempotent and auditable.
- At-least-once Kafka delivery plus idempotent processing: replaying already-processed messages must be a no-op.
- Keep non-required extras out; document them as next steps instead.

## 2. Stack

| Concern | Choice |
|---|---|
| Runtime | Node 22 LTS, TypeScript (strict), pnpm |
| Framework | NestJS (Express adapter) |
| Validation | zod for HTTP bodies, Kafka messages and env config (one small `ZodValidationPipe`) |
| Database | PostgreSQL 16 |
| SQL | Kysely; `pg` type parser configured so `BIGINT` (int8) decodes to `bigint` |
| Kafka | kafkajs wrapped in a Nest provider with manual offset commits (not `@nestjs/microservices`, to keep exact commit control) |
| Local Kafka | Redpanda in docker-compose |
| Auth | JWT bearer, RS256, verified with `jose` in a global guard; `iss`, `aud`, `exp` enforced; scopes `capacity:read`, `capacity:write` |
| Logging | nestjs-pino, structured JSON, request/correlation IDs |
| Tests | Jest, Testcontainers (Postgres, Redpanda), fast-check, supertest |
| Quality | ESLint (typescript-eslint strict), Prettier, GitHub Actions (lint, typecheck, test) |

Code style: no code comments; explanations live in the README. Prefer early returns over if/else-if/else chains. Conventional commits (`feat:`, `fix:`, `test:`, `chore:`, `docs:`).

## 3. Project structure

```
src/
  main.ts
  app.module.ts
  config/            zod-validated env
  money/             Money, Currency (ISO 4217 exponents), FxRate, conversion, rounding policy (pure)
  fx/                FxRateProvider interface + StaticFxRateProvider (seeded rates)
  auth/              global JWT guard, @RequireScope decorator
  database/          Kysely provider, migrations, table types
  capacity/
    domain/          Program, Reservation, errors, reconciliation merge (pure)
    application/     ReserveCapacity, ReleaseReservation, GetCapacity, ApplyTreasuryMessage
    infrastructure/  Postgres repositories
    http/            controller, request schemas, problem+json error mapping
  treasury/          Kafka consumer, message schemas, ordering/parking, DLQ publisher
  health/            DB + Kafka health
scripts/             dev-token, seed, produce-sample-messages
```

Domain and money code are plain TypeScript with no Nest decorators. Avoid pass-through layers that only forward calls; keep one clear transaction boundary per use case.

## 4. Money & FX

- ISO 4217 minor units: USD 2 decimals, JPY 0, KWD 3. A `Currency` table holds exponents.
- JSON carries amounts as strings: `{"amount":"1000000000","currency":"USD"}`.
- `Money` is immutable; operations across different currencies throw.
- Amounts must be positive (limits non-negative) and within Postgres `BIGINT` range, including aggregates.
- FX rates are decimal strings parsed into scaled bigints (`rate × 10^10`). Quote direction is defined in major units (1 unit of invoice currency = `rate` units of program currency); conversion accounts for both exponents and rounds once at the end.
- `FxRateProvider` interface; local `StaticFxRateProvider` reads seeded rates, each with `source` and `asOf`. Missing pair → 422.
- Rounding policy (named, documented):
  - Reservation conversion rounds **up** (conservative).
  - Partial release frees the proportional share of the booked amount, rounded **down**; the final release frees whatever remains so nothing is stranded.
- The FX rate is locked at reservation time and stored on the reservation. Releases never re-convert.
- Program currency is immutable.

## 5. Data model

| Table | Columns / purpose |
|---|---|
| `programs` | `id`, `currency` (immutable), `limit_minor`, `utilised_minor`, `version`, `treasury_revision`, timestamps |
| `reservations` | `id`, `program_id`, `invoice_id` (unique per program, single-use), `status` (`ACTIVE`, `PARTIALLY_RELEASED`, `RELEASED`), `invoice_amount_minor`, `invoice_currency`, `booked_minor` (program currency), `released_minor`, FX snapshot (`fx_rate`, `fx_scale`, `fx_source`, `fx_as_of`), `origin` (`API`, `TREASURY`), timestamps |
| `releases` | `id`, `reservation_id`, `release_id` (client-supplied idempotency key, unique per reservation), `invoice_amount_minor`, `freed_minor`, `origin`, timestamps |
| `ledger_entries` | append-only audit: `type` (`RESERVE`, `RELEASE`, `LIMIT_SET`, `RECONCILE_ADJUST`), `program_id`, `reservation_id`, `delta_minor`, `utilised_after_minor`, `limit_after_minor`, `actor` (JWT `sub` or `treasury`), `correlation_id`, `source_message_id`, `reason`, `created_at` |
| `processed_messages` | Kafka `message_id` for dedupe |
| `pending_treasury_messages` | messages parked because an earlier revision is missing |
| `reconciliation_discrepancies` | `program_id`, `invoice_id`, `kind`, local vs treasury values, `snapshot_revision`, `detected_at`, `resolved_at` |

Invariant: `programs.utilised_minor = Σ(booked_minor − released_minor)` over non-released reservations of that program.

`available = limit_minor − utilised_minor`. It may be negative (see reconciliation); the API exposes it with `overUtilised: true`.

## 6. Concurrency

Every mutation, whether from HTTP or Kafka, runs in one transaction with the same lock order:

1. `SELECT … FROM programs WHERE id = $1 FOR UPDATE`
2. Read/modify reservations and releases
3. Update `utilised_minor`, `limit_minor`, `version`
4. Append ledger entries
5. Commit

One lock order for all writers: no lost updates, no deadlocks.

### Reserve

1. Lock program; unknown → 404.
2. Look up existing reservation for `(program_id, invoice_id)` **before** fetching FX:
   - same original request (invoice amount + currency) → 200 with existing reservation and its current status
   - different request → 409 `invoice-conflict`
3. Fetch FX rate (missing → 422), convert, round up.
4. If `available < booked` → 409 `insufficient-capacity`, nothing written.
5. Insert reservation, update program, append `RESERVE` ledger entry → 201.

### Release

- Optional `amount` in the invoice currency; omitted means release the full remaining amount.
- `releaseId` makes each release idempotent: same `releaseId` + same payload → 200 with original result; different payload → 409.
- Releasing more than outstanding → 422. Releasing a fully released reservation without a new `releaseId` match → 409.
- Same code path serves the HTTP API and treasury `InvoiceRepaid` messages.

## 7. HTTP API

All endpoints require a valid JWT. Errors are RFC 7807 `application/problem+json`.

| Method & path | Scope | Description |
|---|---|---|
| `GET /v1/programs/:programId/capacity` | `capacity:read` | `limit`, `utilised`, `available`, `currency`, `version`, `overUtilised`, `openDiscrepancies` |
| `POST /v1/programs/:programId/reservations` | `capacity:write` | body `{ invoiceId, amount: { amount, currency } }` |
| `GET /v1/programs/:programId/reservations/:invoiceId` | `capacity:read` | reservation incl. FX snapshot, booked and released amounts, releases |
| `POST /v1/programs/:programId/reservations/:invoiceId/releases` | `capacity:write` | body `{ releaseId, amount? }` |
| `GET /v1/programs/:programId/discrepancies` | `capacity:read` | open reconciliation discrepancies |
| `GET /health` | `capacity:read` | DB and Kafka status |

Status codes: 400 validation, 401 missing/invalid token, 403 missing scope, 404 unknown program/reservation, 409 conflict / insufficient capacity, 422 unprocessable (missing FX pair, over-release).

Clients poll `GET /capacity` for real-time availability. Push (SSE) is a documented next step.

## 8. Treasury Kafka ingestion

Topic `treasury.program-capacity.v1`, key = `programId`. DLQ topic `treasury.program-capacity.v1.dlq`.

Every message carries `messageId`, `programId`, `revision` (contiguous per program, starting at 1), `type`, `occurredAt`.

| Type | Payload | Effect |
|---|---|---|
| `ProgramLimitSet` | `currency`, `limit` | creates the program (first message) or changes its limit; a currency change is rejected → DLQ |
| `InvoiceRepaid` | `invoiceId`, `releaseId`, optional `amount` | release via the same path as the API |
| `ProgramSnapshot` | `currency`, `limit`, `asOf`, `reservations: [{ invoiceId, invoiceAmount, invoiceCurrency, bookedAmount }]` | bulk reconciliation via fail-safe merge; may create the program |

### Ordering

| Incoming | Handling |
|---|---|
| `messageId` already processed | skip (duplicate) |
| `revision ≤ treasury_revision` (delta) | skip (stale) |
| `revision = treasury_revision + 1` | apply, then drain contiguous parked messages |
| `revision > treasury_revision + 1` (delta) | park in `pending_treasury_messages` |
| Snapshot with `revision > treasury_revision` | apply merge, set `treasury_revision = revision`, drop parked messages it covers, drain contiguous rest |
| Snapshot with `revision ≤ treasury_revision` | skip (stale) |

### Delivery semantics

- One message at a time per partition; auto-commit disabled.
- Dedupe record + state change in one DB transaction; offset committed only after DB commit or acknowledged DLQ publish.
- Replay after a crash or consumer-group rebalance is a no-op.
- Schema-invalid, unknown-program deltas, unknown-invoice repayments, currency changes, and malformed snapshots (e.g. duplicate invoice IDs) → DLQ with original topic/partition/offset in headers.
- Transient errors (DB unavailable) → retry with backoff, no commit.

### Fail-safe merge

Principle: a snapshot may increase utilisation freely, but may only reduce utilisation for reservations treasury itself introduced. Everything else is flagged as a discrepancy, never auto-applied.

| Scenario | Outcome |
|---|---|
| New limit | applied; if utilised > limit, `available` is negative, `overUtilised: true`, new reservations rejected, existing kept |
| Invoice in snapshot, unknown locally | imported as `ACTIVE`, `origin = TREASURY`, booked amount taken from snapshot (never re-converted) |
| Treasury booked amount higher | applied and audited |
| Treasury amount lower, origin `TREASURY` | applied |
| Treasury amount lower, origin `API` | kept, discrepancy recorded |
| Local active, missing from snapshot, origin `TREASURY` | released |
| Local active, missing from snapshot, origin `API` | kept, discrepancy recorded |
| Local released, snapshot says active | stays released, discrepancy recorded |
| Snapshot with empty reservations list | valid; rules above apply |
| Malformed snapshot | rejected as a whole → DLQ |

All adjustments append `RECONCILE_ADJUST` ledger entries with the snapshot `messageId` and a reason.

## 9. Auth

- RS256 JWT verified with `jose`; `iss`, `aud`, `exp` required.
- Global guard: every route is protected, including `/health`.
- Scopes: `capacity:read`, `capacity:write`.
- Local: `pnpm token:dev` signs tokens with a dev key generated locally (never committed). Production would use the identity provider's JWKS URL.
- Assumption: callers are trusted internal services; no per-program authorization.

## 10. Testing

- **Unit:** Money arithmetic; FX conversion incl. JPY↔KWD, very large amounts, round-up, partial releases summing exactly to the booked amount; every row of the fail-safe merge table; domain rules.
- **Property-based (fast-check):** random sequences of reserve / release / limit change / snapshot: each accepted reservation fit the availability at that moment; the invariant holds; a rejected operation changes neither balances nor ledger.
- **Integration (Testcontainers Postgres):** N parallel reservations against a limit fitting N−1 → exactly one fails; idempotent retry after an FX rate change; double release; release racing a snapshot.
- **Kafka (Testcontainers Redpanda):** replay of already-processed messages is a no-op; stale snapshot ignored; revision gap parked then drained; poison message lands in DLQ; offset not committed when the DB is unavailable.
- **E2E (supertest):** 401/403, validation, problem+json shape, happy paths.

## 11. Local run & delivery

- `docker compose up`: Postgres, Redpanda, app; migrations and seed run automatically; a second start preserves data.
- `token:dev` and `kafka:sample` scripts runnable inside compose so only Docker is required.
- README: quick start, curl walkthrough with expected results (reserve, duplicate retry, partial release, snapshot), short "Design decisions & assumptions" section including the merge table, "Next steps for production" list.

## 12. Out of scope (documented as next steps)

- SSE / push updates
- Transactional outbox publishing capacity events
- OpenTelemetry tracing, Prometheus metrics
- Schema registry (Avro/Protobuf) for Kafka messages
- Deal and counterparty limits (limit hierarchy)
- Per-tenant / per-program authorization
- OpenAPI / Swagger
- Separate ops port for health probes

## 13. Build order

Each step ends with green lint, typecheck and tests, conventional commits, and a code review before the next step starts.

1. Scaffold NestJS project, tooling (ESLint, Prettier, Jest), docker-compose (Postgres, Redpanda), zod config, GitHub Actions CI
2. `money/` and `fx/` with unit and property tests
3. Database schema and migrations; reserve, release and get-capacity use cases; concurrency and invariant tests
4. HTTP controllers, auth guard, problem+json error mapping; e2e tests
5. Kafka consumer, ordering and parking, fail-safe merge, DLQ; Kafka integration tests
6. Scripts (dev token, seed, sample messages), README, final polish

## 14. Deviations recorded during implementation

- NestJS 11, Kysely 0.28 and jose 5 (CommonJS builds) instead of the latest ESM-only majors, so Jest runs without ESM workarounds.
- Every dead letter goes through a `treasury_dead_letters` outbox, unique on source topic/partition/offset and storing the original bytes. Semantic rejections are written in the consuming transaction. Unreadable records and records whose key does not match `programId` are written before the offset commit. Rows are published one at a time with attempt tracking, so one bad row cannot block the rest. A rejected message advances the cursor when it is contiguous. A snapshot rejected ahead of a gap is parked as a marker that the drain consumes when the gap closes.
- Added `reservations.invoice_released_minor` and `releases.requested_invoice_amount_minor` for cumulative partial releases and exact release-idempotency comparison.
- The ordering cursor is a `treasury_streams` row per programme rather than `programs.treasury_revision`. Treasury writers lock it before the programme row; it exists even before the programme, so a rejected first message still advances it.
- Reservations store an allocation base (`allocation_base_invoice_minor`, `allocation_base_released_minor`) that a reconciliation rebook resets. Later partial releases are allocated as `base + floor((booked − base) × (cumInvoice − baseInvoice) / (invoiceAmount − baseInvoice))`.
- Reconciliation applies utilisation decreases before increases. Imports and ledger entries are inserted in chunks, and ID lookups use array binds, so bulk snapshots stay under PostgreSQL's bind-parameter limit.
- Treasury message bodies are strict: unknown fields reject the message. The envelope `type` must be alphanumeric, otherwise the record is unreadable.
- Connections set `lock_timeout` (10 s) and `statement_timeout` (60 s); HTTP maps those timeouts to 503.
- A snapshot's limit change is ledgered as `LIMIT_SET` (reason `SNAPSHOT_LIMIT`); reservation adjustments as `RECONCILE_ADJUST`.
- Release rows store the reservation state they produced (`sequence`, `status_after`, `invoice_released_after_minor`, `booked_after_minor`, `released_after_minor`), so an idempotent replay returns the original response even after later releases. `RELEASED` means the full invoice amount has been repaid. Migration 0001 was amended in place (pre-release).
- HTTP bodies are read as raw buffers and parsed as JSON by the route after the auth guard runs; non-JSON or non-UTF-8 bodies are 415, bodies over 64 kB are 413.
- `/health` returns a 503 problem document (with `checks`) when a dependency is down; an unreachable JWKS endpoint is a 503 `authentication-unavailable` problem rather than a 401.
