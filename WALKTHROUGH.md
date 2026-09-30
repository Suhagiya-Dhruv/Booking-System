# 15-minute walkthrough notes

Read these alongside the implementation before submitting. The exercise asks
the candidate to understand and take responsibility for the actual code.

## 0–3 minutes: request and tenant boundary

Open `src/app.ts`. The token selects the authorized operator. We never trust a
body field to grant access. After validating the body, a different operator is
rejected with 403. `reserve` receives the operator selected by authentication.

Open `src/validation.ts`. It checks required fields, types, nonblank values,
email shape and actual calendar dates. It preserves strings exactly. Timestamp
offsets are converted to UTC, keeping six fractional digits. A BigInt count of
microseconds compares pickup and dropoff without losing precision.

## 3–8 minutes: booking and concurrency

Open `src/reservations.ts` beside `db/schema.sql`.

There are two separate questions: **has this booking ID already succeeded?**
and **is this vehicle available?** Answer the booking question first.

For the same operator and booking ID, requests wait on one PostgreSQL advisory
lock. The second request reads only after the first transaction finishes. An
identical payload gets the saved ID; a changed payload gets a conflict. Group
is deliberately absent from that lock key and from the SQL unique key.

For different booking IDs targeting one pool, requests wait on that pool's row.
The first insert commits. The second insert conflicts with the database's
overlap constraint. Every transaction takes locks in the same order.

The range ends just before dropoff, so a 10:00 return and a 10:00 pickup can
coexist. Including operator in the constraint keeps tenants independent.

## 8–11 minutes: show evidence

Run `npm test`. Open the `race` helper in `test/reservations.test.ts`.
It holds a database lock and waits until both independent servers reach a lock
wait. It then releases them. This makes the concurrency tests meaningful even
on a machine where normal requests finish very quickly.

Show the three race tests and their persisted-row assertions. Then show the
tenant, changed-payload and microsecond tests. There are no mocked database
decisions in these tests.

## 11–13 minutes: failures

If commit succeeds but the response disappears, the same request finds the
committed row and returns its ID. If the process dies before commit, PostgreSQL
rolls back when the connection ends. A failed request does not leave a separate
pending booking key. A 503 during commit can mean an uncertain outcome; retry
with the same ID and payload.

These crash timings are reasoned from the transaction, not fault-injection
tests. Say that explicitly if asked about verification.

## 13–15 minutes: discuss a small change

**If capacity becomes two:** the current exclusion constraint represents one
vehicle, so just adding a capacity column is insufficient. One approach is to
model actual vehicles and exclude overlaps per vehicle, allocate one under a
pool lock, and keep the same operator/booking-ID identity lock.

**If a second broker is added:** clarify whether booking IDs are unique across
brokers. If not, derive broker identity from authentication and include it in
the booking unique key, advisory-lock key and lookup. Availability remains
shared across brokers for the same operator's inventory.

**If pickup/dropoff locations expand:** change the validation and inventory
model together. Relocation affects where a vehicle is available after its
rental, so removing the airport restriction alone does not solve allocation.
