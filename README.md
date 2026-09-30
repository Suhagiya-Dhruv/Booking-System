# Reservation endpoint

A small Node.js / TypeScript / PostgreSQL implementation of `POST /reservations`.
Each seeded pool represents one vehicle. PostgreSQL owns booking identity and
overlap protection, so separate application processes share the same guarantees.

## Setup and run

Requires Node.js **22.9+** and Docker with Compose. Verified with Node.js 22.22.0
and PostgreSQL 16.15. All commands below run from the repository root.

```sh
npm ci
```

Copy the supplied environment file:

```sh
# macOS / Linux
cp .env.example .env
```

```powershell
# Windows PowerShell
Copy-Item .env.example .env
```

Then:

```sh
docker compose -p caravel-reservation-exercise up -d --wait
npm run db:setup
npm run build
npm start
```

The API listens on `http://127.0.0.1:3000`. PostgreSQL is exposed only on
`127.0.0.1:55432` to avoid an existing database on port 5432. The credentials in
`.env.example` are public, fictional local fixtures. `.env` is ignored by Git.

`db:setup` creates missing tables and seeds the **application** database. It is
safe to rerun: existing tables and reservations are preserved, and the seed does
not duplicate inventory pools. This setup command does not migrate or repair an
existing table with a different schema; schema changes need explicit migrations.
Compose creates the separate `reservations_test` database on first initialization.
For a pre-existing Compose volume without that database, create it once:

```sh
docker compose -p caravel-reservation-exercise exec -T postgres createdb -U reservations reservations_test
```

Without Docker, use PostgreSQL 16+ with two empty databases, set `DATABASE_URL`
and `TEST_DATABASE_URL` in `.env`, and run the same npm commands. The setup/test
role must be able to create tables and the `btree_gist` extension. SQL is also
directly executable in this order: [schema](db/schema.sql), [seed](db/seed.sql).

## Try it

```sh
curl -i http://127.0.0.1:3000/reservations -H "Authorization: Bearer test-token-a" -H "Content-Type: application/json" --data-binary @examples/reservation.json
```

On Windows PowerShell, use `curl.exe` in place of `curl`. Running the request
twice returns `201`, then `200`, with the same `reservationId`:

```json
{
  "reservationId": "<database-generated UUID>",
  "externalBookingId": "BROKER-1001",
  "operatorId": "operator-a"
}
```

Change `customer.name` while retaining the ID to get `409 IDEMPOTENCY_CONFLICT`.
Use another booking ID for the same period and pool to get `409 NO_AVAILABILITY`.
Every error has `{ "error": { "code": "...", "message": "..." } }`.

| Result | HTTP | Code |
| --- | --- | --- |
| New committed booking | 201 | Success body |
| Identical successful retry | 200 | Original success body |
| Existing key, changed valid payload | 409 | `IDEMPOTENCY_CONFLICT` |
| Overlapping reservation | 409 | `NO_AVAILABILITY` |
| Invalid input / unsupported pool | 400 | `INVALID_REQUEST` |
| Missing / invalid token | 401 | `UNAUTHORIZED` |
| Valid body names another operator | 403 | `FORBIDDEN` |
| Database / unexpected infrastructure failure | 503 | `SERVICE_UNAVAILABLE` |

Only `test-token-a` / `operator-a` and `test-token-b` / `operator-b` exist.
The authenticated operator is passed to every database identity and pool query.
The seeded pools are A/economy/airport, A/compact/airport, B/economy/airport.

## Where requests wait or conflict

The complete transaction is in [`reserve`](src/reservations.ts); the database
constraints are in [`db/schema.sql`](db/schema.sql).

1. Authentication and structural validation happen before opening a transaction.
2. `BEGIN ISOLATION LEVEL READ COMMITTED` starts a transaction on one checked-out
   database connection. `pg_advisory_xact_lock(hashtextextended(...))` locks the
   JSON-encoded pair **[authorized operator, externalBookingId]**. A competing
   request with the same key waits here, including when it names another group.
   The transaction releases the lock automatically on commit or rollback.
   A hash collision only serializes unrelated requests: actual identity is
   always checked using both original strings in SQL.
3. After checking that the requested inventory exists, the next SQL statement
   reads the existing reservation. READ COMMITTED provides a fresh snapshot
   after the lock wait, so it sees a winning transaction's committed row.
   SQL compares every remaining business field, including both customer fields,
   locations and timestamps. Timestamps are compared as `timestamptz` values;
   object key order is irrelevant. Other strings retain their exact values.
4. If the row exists, return `200` for equality or `409 IDEMPOTENCY_CONFLICT` for
   a different valid payload. **No availability check precedes this decision.**
5. For a new key, `SELECT ... FOR UPDATE` on its inventory row serializes new
   bookings for that one pool. Different pools have different rows. Identity
   locks are always taken before pool locks. This also avoids two simultaneous
   exclusion-index inserts deadlocking against one another in the endpoint.
6. Insert the reservation. `no_overlapping_reservations`, a GiST exclusion
   constraint, rejects intersecting `tstzrange(..., '[)')` periods within the
   same operator/group/location. Its specific `23P01` error becomes
   `409 NO_AVAILABILITY` after rollback. A database unique constraint separately
   enforces `(operator_id, external_booking_id)`, regardless of group or dates.
7. Commit **before** sending `201`. There is no separately committed pending-key
   record. An invalid request or failed insert therefore consumes no key.

Half-open `[pickup, dropoff)` ranges allow adjacent rentals and reject partial
overlap or containment in either direction. The constraints also protect data
if another SQL writer bypasses application checks, although that writer must
follow this protocol to provide the same HTTP retry semantics.

See PostgreSQL's documentation for [transaction advisory locks](https://www.postgresql.org/docs/16/explicit-locking.html#ADVISORY-LOCKS)
and [range exclusion constraints](https://www.postgresql.org/docs/16/rangetypes.html#RANGETYPES-CONSTRAINT).

## Failure and retry behavior

**Database commits, but the broker never receives the response:** the reservation
and booking identity are already durable. Retrying with the same operator, ID
and payload reads that row and returns `200` with the original reservation ID,
even though its vehicle is now occupied. A connection error during `COMMIT` can
leave the outcome unknown to the application; a `503` or a lost response does
not prove rollback. The broker must retry with the same key and payload.

**Process stops before commit:** when PostgreSQL detects the broken connection,
it rolls back the uncommitted insert and releases transaction/row locks. A retry
can then book normally. The process may take time to be detected during a network
partition. Local lock and statement timeouts bound ordinary request waits to
5 and 10 seconds; a timeout returns a sanitized `503` and the broker can retry.
There is no automatic application-level retry loop.

## Tests and evidence

```sh
npm test
```

This compiles TypeScript, recreates the two tables **only in `TEST_DATABASE_URL`**,
and runs against real PostgreSQL. The URL is mandatory and its database name
must end in `_test`. Use a dedicated disposable database: its reservation and
inventory tables are dropped/recreated, and reservations are truncated between
tests. Tests do not use `DATABASE_URL` as a fallback and do not mock PostgreSQL.

The suite starts **two separate Node.js server processes**, each with its own
pool, and makes real HTTP requests. For the three required races, a third
database session temporarily holds a blocking lock. The test inspects
`pg_stat_activity` and requires both server sessions to be waiting on locks
before releasing them. Assertions check HTTP outcomes **and persisted rows**.

Verified locally: **18/18 automated tests passed**, TypeScript compilation passed,
and the application setup script produced exactly the three specified pools.

| Verified behavior | Evidence in `test/reservations.test.ts` |
| --- | --- |
| New booking and identical retry across processes | Same ID, all stored fields, unchanged row |
| Concurrent different IDs, one pool | One 201, one 409, one stored winner |
| Concurrent identical requests | One 201, one 200, same ID, one row |
| Concurrent same ID across groups | One 201, one idempotency conflict, winning group stored |
| Tenant and group independence | Independent successes, IDs, scoped replays; mismatch rejected |
| Adjacent/partial/contained/equal intervals | Expected acceptance or conflict and row counts |
| Changed valid business fields | Conflicts before availability; original unchanged |
| Equivalent timezones and JSON ordering | Replay returns original ID |
| Microsecond precision | Distinct instants conflict, adjacency succeeds, exact stored fraction |
| Rejected keys are reusable | Corrected request succeeds after 400 or availability failure |
| Validation and auth | Missing/types/blank/email/calendar/timezone/pool/JSON/size/token failures |
| Past dates and exact strings | Leap day accepted; IDs with trailing spaces remain distinct |
| Direct SQL bypass | Exclusion and uniqueness violations leave original unchanged |
| Infrastructure failure | Real refused database connection gives sanitized 503 |
| Repeated setup | Setup script runs twice on populated tables, preserving rows and three pools |

Not fault-injected: process termination immediately before commit, loss of the
HTTP response immediately after commit, database restart/failover, network
partitions, and timeout recovery. Those explanations follow the transaction
design; the suite does not claim to have simulated them. No sustained load test
or deployment validation was performed.

## Concrete review and correction

A plausible mistake is locking `(operator, group, booking ID)` instead of
`(operator, booking ID)`: simultaneous economy/compact requests could both pass
the lookup. The cross-group test forces both processes to contend and checks
that only one reservation exists. The SQL unique constraint is a second defense.

During review of the AI-generated implementation, blank `operatorId` initially
went through the mismatch check and would have returned `403`. Validation now
runs first so blank input returns `400`; the invalid-input test includes that
case. A second explicit verification checks timestamps one microsecond apart,
preventing JavaScript millisecond truncation from hiding a changed payload.

## Scope and production priorities

Intentional limits: exactly one vehicle per fixed pool; no modifications,
cancellations, prices, holds, real broker, UI, webhook, deployment or CI.
Timestamps use ISO calendar date/time syntax with a required `Z` or numeric
offset, years 0001–9999, and up to six fractional digits (PostgreSQL precision).
Invalid dates and leap seconds are rejected. Strings are limited to 256 UTF-16
code units and must contain valid Unicode; NUL is rejected. Requests are limited
to 16 KiB. Unknown JSON fields are ignored and are not business identity fields.
Different valid spellings of a timestamp are equivalent; other strings are not
trimmed or lowercased. New bookings in one pool serialize even for disjoint dates.

The three highest-priority production improvements would be:

1. Replace fixture tokens with managed, rotatable broker credentials; use TLS,
   a least-privilege database role and defense-in-depth tenant access controls.
2. Add request IDs, safe structured logs, metrics for lock waits/conflicts and
   latency, rate limits and measured pool/timeout limits under realistic load.
3. Add versioned migrations, backup/restore verification and fault-injection
   tests for uncertain commits, process death and database failover.

## Submission notes

- Time spent: approximately 15 minutes on 30 September 2026, including implementation,
  dependency/database setup, review, automated tests and documentation (within the
  90-minute exercise limit), including a follow-up fix for repeatable database setup.
  Candidate reading and follow-up preparation are separate.
- AI tools used: OpenAI Codex for implementation, review, tests and documentation.
- Synthetic customer data only; no real broker credentials or customer records.
- [Walkthrough notes](WALKTHROUGH.md) explain the code for the follow-up discussion.

Stop the local database without deleting its data:

```sh
docker compose -p caravel-reservation-exercise stop
```
