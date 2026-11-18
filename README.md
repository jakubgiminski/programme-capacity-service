# Programme Capacity Service

Tracks a financing programme's credit capacity in real time: invoice reservations, full and partial releases, current availability, and treasury data ingested from Kafka, including bulk reconciliation snapshots. Brief: [docs/SPEC.md](docs/SPEC.md). Agreed plan: [docs/PLAN.md](docs/PLAN.md).

Stack: Node 22, TypeScript (strict), NestJS 11, PostgreSQL 16 (Kysely), kafkajs (Redpanda locally), zod, jose, Jest with Testcontainers and fast-check.

## Quick start (Docker only)

```bash
docker compose up --build -d
TOKEN=$(docker compose exec -T app node dist/scripts/dev-token.js)
curl -s -H "Authorization: Bearer $TOKEN" localhost:3000/health
# {"status":"ok","checks":{"database":"up","kafka":"up"}}
```

On start the app container generates a local RS256 key pair (in a Docker volume, never committed), runs migrations, seeds `PRG-USD-001` (USD 10,000,000.00), `PRG-EUR-001` and `PRG-JPY-001`, then starts. Restarting keeps data, keys and consumer offsets. `docker compose down -v` resets everything.

Token options: `dev-token.js --scope capacity:read --sub erp-service --ttl 600`.

## Walkthrough

All amounts are strings in integer minor units (`"10000000"` EUR = €100,000.00).

```bash
H="Authorization: Bearer $TOKEN"; J='Content-Type: application/json'; P=localhost:3000/v1/programs/PRG-USD-001

curl -s -H "$H" $P/capacity
# limit 1000000000 USD, utilised 0, available 1000000000, version "0"

curl -s -H "$H" -H "$J" $P/reservations \
  -d '{"invoiceId":"INV-1001","amount":{"amount":"10000000","currency":"EUR"}}'
# 201, booked {"amount":"10850000","currency":"USD"} at the locked rate 1.085 (rounded up)

# same request again (client retry)            -> 200 with the same reservation, nothing booked twice
# same invoiceId, different amount             -> 409 /problems/invoice-conflict

curl -s -H "$H" -H "$J" $P/reservations/INV-1001/releases \
  -d '{"releaseId":"REL-1","amount":{"amount":"4000000","currency":"EUR"}}'
# 201, freed 4340000 USD, status PARTIALLY_RELEASED, outstanding 6510000
# same releaseId + payload again -> 200; omit "amount" with a new releaseId to release the remainder

curl -s -H "$H" -H "$J" $P/reservations \
  -d '{"invoiceId":"INV-BIG","amount":{"amount":"2000000000","currency":"USD"}}'
# 409 /problems/insufficient-capacity with "requested" and "available"

docker compose exec -T app node dist/scripts/produce-sample-messages.js snapshot-usd
curl -s -H "$H" $P/capacity        # limit 900000000, utilised 31510000, openDiscrepancies 1
curl -s -H "$H" $P/discrepancies   # INV-1001 TREASURY_AMOUNT_LOWER: kept local 6510000, treasury says 5000000
# TRE-9001 was imported as a TREASURY reservation. Re-sending the snapshot changes nothing (same messageId).

docker compose exec -T app node dist/scripts/produce-sample-messages.js lifecycle
# PRG-TRE-001: created by ProgramLimitSet, snapshot import, revision 4 parked until 3 arrives,
# a duplicate delivery skipped, and a repayment for an unknown invoice sent to the DLQ:
docker compose exec redpanda rpk topic consume treasury.program-capacity.v1.dlq -n 1
```

Errors are `application/problem+json` (RFC 7807) with `type`, `title`, `status`, `detail`, `instance` and `correlationId` (also returned as the `X-Correlation-Id` header and written to the ledger).

## API

| Method & path                                                   | Scope            | Notes                                                                             |
| --------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------- |
| `GET /v1/programs/:programId/capacity`                          | `capacity:read`  | `limit`, `utilised`, `available`, `overUtilised`, `openDiscrepancies`, `version`  |
| `POST /v1/programs/:programId/reservations`                     | `capacity:write` | `{ invoiceId, amount: { amount, currency } }`; 201 created, 200 idempotent replay |
| `GET /v1/programs/:programId/reservations/:invoiceId`           | `capacity:read`  | FX snapshot, booked/released amounts, releases                                    |
| `POST /v1/programs/:programId/reservations/:invoiceId/releases` | `capacity:write` | `{ releaseId, amount? }` in invoice currency; omitted = remaining                 |
| `GET /v1/programs/:programId/discrepancies`                     | `capacity:read`  | open reconciliation discrepancies                                                 |
| `GET /health`                                                   | `capacity:read`  | database and Kafka status; 503 when either is down                                |

400 validation · 401 missing/invalid token · 403 missing scope · 404 unknown programme/reservation · 409 invoice conflict, insufficient capacity, release conflict, already released · 422 missing FX pair, over-release, wrong release currency.

## Treasury messages

Topic `treasury.program-capacity.v1` (key = `programId`), DLQ `treasury.program-capacity.v1.dlq`. Every message has `messageId`, `programId`, `revision` (contiguous per programme from 1), `type`, `occurredAt`:

```json
{ "type": "ProgramLimitSet", "currency": "USD", "limit": "500000000" }
{ "type": "InvoiceRepaid", "invoiceId": "TRE-2", "releaseId": "rp-1", "amount": { "amount": "100", "currency": "USD" } }
{ "type": "ProgramSnapshot", "currency": "USD", "limit": "500000000", "asOf": "…",
  "reservations": [{ "invoiceId": "TRE-1", "invoiceAmount": "2000000", "invoiceCurrency": "EUR", "bookedAmount": "2170000" }] }
```

`bookedAmount` is treasury's outstanding utilisation for the invoice in programme currency.

## Development

```bash
pnpm install
docker compose up -d postgres redpanda
cp .env.example .env && pnpm keys:dev && pnpm db:migrate && pnpm db:seed
pnpm start:dev                 # http://localhost:3000
pnpm token:dev                 # bearer token for the local key pair
pnpm kafka:sample lifecycle    # produce sample treasury messages to localhost:19092
pnpm lint && pnpm typecheck && pnpm test   # tests need Docker (Testcontainers)
```

Tests: unit and property tests for money, FX, release allocation, ordering and every merge rule; Postgres tests for concurrency (N parallel reservations against a limit that fits N−1, concurrent duplicate requests and releases, a release racing a snapshot), idempotency and a fast-check property test over random reserve/release/limit/snapshot sequences that checks the invariants after every step; Redpanda tests for replay from offset zero, gap parking, stale snapshots, DLQ routing and no offset commit during a database outage; supertest e2e tests for auth, validation and problem documents.

## Design decisions & assumptions

- **Money** is `bigint` minor units end to end (`BIGINT` in Postgres, strings in JSON), ISO 4217 exponents (JPY 0, KWD 3). Amounts, aggregates and conversions are range-checked against `BIGINT`.
- **FX** rates are decimal strings scaled by 10^10; 1 unit of invoice currency = `rate` units of programme currency. Conversion rounds once, **up** for reservations (conservative). The rate, source and `asOf` are locked on the reservation; releases never re-convert. The static provider has explicit pairs only (no derived inverses); a missing pair is 422.
- **Partial releases** free `floor(booked × cumulativeInvoiceReleased / invoiceAmount) − alreadyFreed`; the final release frees whatever remains, so nothing is stranded or over-freed.
- **Concurrency**: every write runs in one transaction that first locks the programme row (`SELECT … FOR UPDATE`), then reads/writes reservations, then updates the programme and appends the ledger. One lock order for HTTP and Kafka: no lost updates, no deadlocks. Idempotency is checked under the lock and before fetching FX, so a retry after a rate change returns the original booking.
- **Audit**: append-only `ledger_entries` (enforced by a trigger) with actor (JWT `sub` or `treasury`), correlation ID, source message ID and reason. Invariant `utilised = Σ(booked − released)` over open reservations is asserted by the tests. Programme currency is immutable (trigger).
- **Kafka delivery**: auto-commit off; an offset is committed only after the message's DB transaction commits (or, for unreadable messages, after the DLQ publish is acknowledged). Transient failures retry with capped backoff without committing. Dedupe on `messageId` plus revision ordering make replays, rebalances and crash-restarts no-ops.
- **Ordering**: stale revisions are skipped, gaps are parked and drained once contiguous, a snapshot newer than the applied revision is applied and supersedes parked messages it covers. A per-programme advisory lock serialises a programme's stream even before its row exists (a treasury message may create the programme).
- **Fail-safe merge**: a snapshot may raise utilisation freely but may only lower it for reservations treasury itself introduced:

  | Scenario                             | Outcome                                                                                                  |
  | ------------------------------------ | -------------------------------------------------------------------------------------------------------- |
  | New limit                            | applied; if utilised > limit, `available` goes negative, `overUtilised: true`, new reservations rejected |
  | Invoice unknown locally              | imported as `ACTIVE`, origin `TREASURY`, booked amount from the snapshot                                 |
  | Treasury amount higher               | applied and audited                                                                                      |
  | Treasury amount lower                | applied for origin `TREASURY`; kept + discrepancy for origin `API`                                       |
  | Missing from snapshot                | released for origin `TREASURY`; kept + discrepancy for origin `API`                                      |
  | Released locally, active in snapshot | stays released + discrepancy                                                                             |
  | Invoice amount/currency differs      | discrepancy (amount rules still apply)                                                                   |
  | Malformed snapshot / currency change | rejected as a whole → DLQ                                                                                |

  Discrepancies stay open until a later snapshot no longer reports them.

- **Auth**: RS256 JWT verified with `jose` (`iss`, `aud`, `exp`, `sub` required; RS256 only) in a global guard; routes without a declared scope are denied. Callers are trusted internal services: no per-programme authorisation. Production would use the IdP's JWKS (`JWT_JWKS_URL`).
- **Programmes** are created by treasury (`ProgramLimitSet` or `ProgramSnapshot`) or the local seed; there is no HTTP endpoint for them.
- **Real-time** availability is served by polling `GET /capacity`; `version` changes on every capacity mutation.

Deviations from the plan, kept minimal:

- NestJS 11, Kysely 0.28 and jose 5 (CommonJS builds) instead of the latest ESM-only majors, so Jest runs without ESM workarounds.
- Semantic rejections (unknown invoice, currency change, over-release, invalid body) are written to a `treasury_dead_letters` outbox in the same transaction and published to the DLQ after commit, so a crash cannot lose a dead letter or skip a revision. DLQ delivery is at-least-once (`x-message-id` header for dedupe). A rejected message advances the programme's revision only when it is the next contiguous one.
- `reservations.invoice_released_minor` and `releases.requested_invoice_amount_minor` were added to support cumulative partial releases and exact release-idempotency comparison.
- A snapshot's limit change is ledgered as `LIMIT_SET` (reason `SNAPSHOT_LIMIT`); reservation adjustments are `RECONCILE_ADJUST`.
- Deltas for a programme that does not exist yet are parked by revision like any other gap; an `InvoiceRepaid` for an unknown programme is dead-lettered.

## Next steps for production

- Push updates (SSE or a capacity-events topic via a transactional outbox).
- OpenTelemetry tracing, Prometheus metrics (consumer lag, parked messages, open discrepancies, DLQ rate) and alerting.
- Schema registry (Avro/Protobuf) and versioned contracts for treasury messages.
- Live FX provider with rate staleness limits; deal and counterparty limit hierarchy.
- Per-tenant / per-programme authorisation; separate ops port for health probes; OpenAPI docs.
- Retention/archival for `processed_messages` and the ledger; a reprocessing tool for DLQ messages and a workflow to resolve discrepancies.
