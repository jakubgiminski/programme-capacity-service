# Programme Capacity Service

Tracks a financing programme's credit capacity in real time: invoice reservations, full and partial releases, current availability, and treasury data ingested from Kafka, including bulk reconciliation snapshots. Brief: [docs/SPEC.md](docs/SPEC.md). Agreed plan and recorded deviations: [docs/PLAN.md](docs/PLAN.md).

Stack: Node 22, TypeScript (strict), NestJS 11, PostgreSQL 16 (Kysely), kafkajs (Redpanda locally), zod, jose, Jest with Testcontainers and fast-check.

## Quick start (Docker only)

```bash
docker compose up --build -d
until TOKEN=$(docker compose exec -T app node dist/scripts/dev-token.js 2>/dev/null) &&
  curl -fs -H "Authorization: Bearer $TOKEN" localhost:3000/health; do sleep 2; done
docker compose exec -T app node dist/scripts/smoke.js
```

The loop ends once `/health` returns `{"status":"ok","checks":{"database":"up","kafka":"up"}}`. The smoke test then drives a new programme through every flow below and asserts each response. It is repeatable and also runs in CI.

On start the app container generates a local RS256 key pair in a Docker volume (never committed), runs migrations, seeds `PRG-USD-001` (USD 10,000,000.00), `PRG-EUR-001` and `PRG-JPY-001`, then starts. Restarting keeps data, keys and consumer offsets; `docker compose down -v` resets everything. `dev-token.js` accepts `--scope capacity:read --sub erp-service --ttl 600`.

## Walkthrough

Amounts are strings in integer minor units (`"10000000"` EUR is €100,000.00).

```bash
H="Authorization: Bearer $TOKEN"; J='Content-Type: application/json'; P=localhost:3000/v1/programs/PRG-USD-001
curl -s -H "$H" $P/capacity
curl -s -H "$H" -H "$J" $P/reservations -d '{"invoiceId":"INV-1001","amount":{"amount":"10000000","currency":"EUR"}}'
curl -s -H "$H" -H "$J" $P/reservations/INV-1001/releases -d '{"releaseId":"REL-1","amount":{"amount":"4000000","currency":"EUR"}}'
curl -s -H "$H" -H "$J" $P/reservations -d '{"invoiceId":"INV-BIG","amount":{"amount":"2000000000","currency":"USD"}}'
docker compose exec -T app node dist/scripts/produce-sample-messages.js snapshot-usd
curl -s -H "$H" $P/capacity
curl -s -H "$H" $P/discrepancies
```

1. The programme starts with limit, available `1000000000` USD and `version` `"0"`.
2. The reservation returns 201 and books `10850000` USD at the locked rate 1.085, rounded up. Sending it again returns 200 with the same reservation; the same `invoiceId` with another amount returns 409 `/problems/invoice-conflict`.
3. The release returns 201, frees `4340000` USD and leaves the reservation `PARTIALLY_RELEASED` with `6510000` outstanding. Repeating `REL-1` returns 200 with the original result; a new `releaseId` without `amount` releases the remainder.
4. The oversized reservation returns 409 `/problems/insufficient-capacity` with `requested` and `available`.
5. The snapshot is consumed asynchronously; repeat the capacity call until `treasury.revision` is `"1"`. The limit is then `900000000`, utilised `31510000` and `openDiscrepancies` 1: treasury reports a lower exposure for API invoice `INV-1001`, so the local `6510000` is kept and flagged, while `TRE-9001` is imported as a treasury reservation. Re-sending the snapshot changes nothing.

`produce-sample-messages.js lifecycle` creates `PRG-TRE-001` from treasury messages, parks revision 4 until 3 arrives, skips a duplicate delivery, and dead-letters a repayment for an unknown invoice (`docker compose exec redpanda rpk topic consume treasury.program-capacity.v1.dlq -n 1`).

## API

| Method & path                                                   | Scope            | Notes                                                                             |
| --------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------- |
| `GET /v1/programs/:programId/capacity`                          | `capacity:read`  | `limit`, `utilised`, `available`, `overUtilised`, `openDiscrepancies`, `treasury` |
| `POST /v1/programs/:programId/reservations`                     | `capacity:write` | `{ invoiceId, amount: { amount, currency } }`; 201 created, 200 replay            |
| `GET /v1/programs/:programId/reservations/:invoiceId`           | `capacity:read`  | FX snapshot, invoice and booked amounts, release history                          |
| `POST /v1/programs/:programId/reservations/:invoiceId/releases` | `capacity:write` | `{ releaseId, amount? }` in invoice currency; omitted releases the remainder      |
| `GET /v1/programs/:programId/discrepancies`                     | `capacity:read`  | open reconciliation discrepancies; `?limit=1..500&after=<nextCursor>`             |
| `GET /health`                                                   | `capacity:read`  | database and Kafka status; 503 problem document when either is down               |

`treasury` on the capacity view shows the last consumed revision, the number of parked messages, when the oldest was parked, and the lowest limit waiting behind a gap. `available` already accounts for that pending limit.

Errors are `application/problem+json` (RFC 7807) with `type`, `title`, `status`, `detail`, `instance` and `correlationId` (also the `X-Correlation-Id` header and the ledger). Status codes: 400 invalid input, malformed JSON or invalid UTF-8; 401 missing or invalid token; 403 missing scope; 404 unknown programme or reservation; 409 invoice conflict, insufficient capacity, release conflict or already released; 413 body over 64 kB; 415 not `application/json` or not UTF-8; 422 missing FX pair, over-release or wrong release currency; 503 database, Kafka (`/health`) or JWKS unavailable, or a lock or statement timeout.

## Treasury messages

Topic `treasury.program-capacity.v1` (key = `programId`), DLQ `treasury.program-capacity.v1.dlq`. Every message has `messageId`, `programId`, `revision` (contiguous per programme from 1), `type` and `occurredAt`:

```json
{ "type": "ProgramLimitSet", "currency": "USD", "limit": "500000000" }
{ "type": "InvoiceRepaid", "invoiceId": "TRE-2", "releaseId": "rp-1", "amount": { "amount": "100", "currency": "USD" } }
{ "type": "ProgramSnapshot", "currency": "USD", "limit": "500000000", "asOf": "…",
  "reservations": [{ "invoiceId": "TRE-1", "invoiceAmount": "2000000", "invoiceCurrency": "EUR",
                     "outstandingInvoiceAmount": "1500000", "bookedAmount": "1627500" }] }
```

A snapshot at revision N states treasury's complete programme state after applying revisions 1..N; `asOf` must not move backwards. `outstandingInvoiceAmount` is the unpaid invoice amount in invoice currency (1..`invoiceAmount`). `bookedAmount` is treasury's outstanding exposure in programme currency; `"0"` is valid. A snapshot holds at most 50,000 reservations and topics are created with `max.message.bytes` of 16 MiB. Approvals arrive only through the HTTP API: treasury messages never create API reservations.

## Guarantees and design decisions

- **Money** is `bigint` minor units end to end (`BIGINT` in Postgres, strings in JSON) with ISO 4217 exponents (JPY 0, KWD 3). Amounts, aggregates and conversions are range-checked against `BIGINT`.
- **FX** rates are decimal strings scaled by 10^10; 1 unit of invoice currency = `rate` units of programme currency. Reservations round **up** once. The rate, source and `asOf` are locked on the reservation and releases never re-convert. The static provider has explicit pairs only; a missing pair is 422.
- **Partial releases** free `floor(booked × invoiceRepaid / invoiceAmount)` cumulatively and the final release frees the remainder, so nothing is stranded or over-freed. When a snapshot rebooks a reservation, later repayments are allocated over the remaining invoice amount and the new exposure. `RELEASED` means the whole invoice is repaid.
- **Idempotency**: a repeated reservation (same invoice, amount and currency, API origin) returns 200 with the reservation's current state; a repeated release (same `releaseId` and amount) returns its original result, even after later releases. Both are checked under the programme lock before FX is fetched. An invoice imported from treasury cannot be reserved through the API (409).
- **Concurrency**: each write is one transaction. HTTP writers lock the programme row; treasury writers lock the per-programme `treasury_streams` row first, then the programme row. The single lock order prevents lost updates and deadlocks. Reads use a read-only repeatable-read transaction. `lock_timeout` (10 s) and `statement_timeout` (60 s) map to 503.
- **Audit**: append-only `ledger_entries` (enforced by a trigger) record actor (JWT `sub` or `treasury`), correlation ID, source message ID and reason. Tests assert `utilised = Σ(booked − released)` over open reservations. Programme currency is immutable.
- **Kafka delivery**: values are decoded as strict UTF-8; offsets are committed manually after the database transaction commits. Transient failures retry with capped backoff while heartbeating; a failed heartbeat (lost assignment) stops the retries. Dedupe on `messageId`, checked with a payload fingerprint, plus per-programme revision ordering make replays and rebalances no-ops. A reused `messageId` with different content is dead-lettered. The record key must equal `programId`.
- **Ordering**: stale revisions are skipped. Deltas after a gap are parked and drained in bounded transactions once the gap closes. A valid snapshot newer than the cursor applies immediately and supersedes the parked deltas it covers. Invalid messages are dead-lettered on arrival; a rejected message ahead of a gap leaves a marker so the cursor still advances when the gap closes. While a lower limit is parked, new reservations are admitted against it.
- **DLQ**: every rejected, unreadable or key-mismatched record becomes a row in the `treasury_dead_letters` outbox, unique per source topic/partition/offset, in the same transaction as its outcome or before its offset commit. A replay never creates a second row. An independent publisher sends rows with the original key and bytes (tombstones stay null) and `x-dlq-reason`, `x-original-topic/partition/offset` and `x-message-id` headers. Publishing is at least once, so DLQ consumers dedupe on the `x-original-*` headers.
- **Fail-safe merge**: a snapshot may raise utilisation freely but may only lower it for reservations treasury itself introduced:

  | Scenario                                      | Outcome                                                                                                  |
  | --------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
  | New limit                                     | applied; if utilised > limit, `available` goes negative, `overUtilised: true`, new reservations rejected |
  | Invoice unknown locally                       | imported as origin `TREASURY` with treasury's exposure and repayments                                    |
  | Treasury exposure higher                      | applied and audited                                                                                      |
  | Treasury exposure lower                       | applied for origin `TREASURY`; kept + discrepancy for origin `API`                                       |
  | Treasury reports more of the invoice repaid   | adopted for origin `TREASURY`; kept + discrepancy for origin `API`                                       |
  | Missing from snapshot                         | released for origin `TREASURY`; kept + discrepancy for origin `API`                                      |
  | Released locally, active in snapshot          | stays released + discrepancy                                                                             |
  | Invoice amount or currency differs            | discrepancy (exposure rules still apply)                                                                 |
  | Malformed, currency change, `asOf` regression | rejected as a whole → DLQ                                                                                |

  Discrepancies stay open until a later snapshot no longer reports them. `version` counts balance changes, so a snapshot that only changes discrepancies leaves it unchanged.

- **Auth**: RS256 JWTs verified with `jose` (`iss`, `aud`, `exp`, `sub` required) in a global guard; routes without a declared scope are denied. Bodies are read (64 kB, strict UTF-8) only after authentication. JWKS downloads have a full-response deadline; an unreachable endpoint is a 503 for that request and the cache recovers when it answers again. Callers are trusted internal services; there is no per-programme authorisation.
- **Programmes** are created by treasury (`ProgramLimitSet` or `ProgramSnapshot`) or the local seed; there is no HTTP endpoint for them. Real-time availability is served by polling `GET /capacity`.

## Operations

- **Configuration**: see [.env.example](.env.example) and [src/config/config.ts](src/config/config.ts). Production Kafka uses `KAFKA_SSL=true` (trust via `NODE_EXTRA_CA_CERTS`) and `KAFKA_SASL_MECHANISM`/`USERNAME`/`PASSWORD`. Set `KAFKA_CREATE_TOPICS=false` for pre-provisioned topics with `max.message.bytes` of at least 16 MiB.
- **Stalled stream**: `treasury.parkedMessages` and `oldestParkedAt` on the capacity view show a programme waiting for a missing revision. Treasury recovers by re-sending the missing revision or publishing a snapshot with a higher revision.
- **Dead letters**: `treasury_dead_letters` keeps every rejection with `attempts` and `last_error` until it is published. A corrected message must be re-sent with a new revision and `messageId`.

## Development

```bash
pnpm install
docker compose up -d postgres redpanda
cp .env.example .env && pnpm keys:dev && pnpm db:migrate && pnpm db:seed
pnpm start:dev
pnpm token:dev
pnpm kafka:sample lifecycle
pnpm smoke
pnpm lint && pnpm typecheck && pnpm test
```

`pnpm start:dev` serves on `localhost:3000`; `pnpm token:dev` prints a bearer token; `pnpm test` needs Docker for Testcontainers, and `pnpm test:coverage` adds a V8 coverage report.

Tests cover money, FX, allocation (property-based over the production release planner), ordering and every merge rule as unit tests. Postgres tests cover concurrency (N parallel reservations against a limit that fits N−1, concurrent duplicates, a release racing a snapshot), idempotency, out-of-order snapshots and repayments, gap admission, bounded drains, and a fast-check model of random reserve/release/limit/snapshot sequences that compares every reservation after each step. Redpanda tests cover replay from offset zero, gap parking, per-partition offset commits, byte-exact DLQ payloads, a failed offset commit, a database outage and a maximum-size snapshot. Supertest e2e tests cover auth, validation, pagination and problem documents.

## Next steps for production

- Push updates (SSE or a capacity-events topic via a transactional outbox) and an OpenAPI description generated from the request and response schemas.
- OpenTelemetry tracing, Prometheus metrics (consumer lag, parked messages, open discrepancies, DLQ backlog) and alerting.
- Schema registry (Avro/Protobuf), versioned treasury contracts and chunked snapshots beyond 50,000 reservations.
- Live FX provider with staleness limits; deal and counterparty limit hierarchy.
- Per-tenant authorisation, a separate ops port for health probes, and list endpoints for programmes and reservations.
- Retention for `processed_messages` and the ledger, DLQ reprocessing tooling, and a workflow to resolve discrepancies.
