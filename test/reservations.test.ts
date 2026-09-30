import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { execFile, fork, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import pg from 'pg';
import type { Booking } from '../src/validation.js';
import { createApp } from '../src/app.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || !new URL(connectionString).pathname.endsWith('_test')) {
  throw new Error('TEST_DATABASE_URL must explicitly name a disposable database ending in _test.');
}
const db = new pg.Pool({ connectionString, max: 5 });
const children: ChildProcess[] = [];
const urls: string[] = [];
const base: Booking = {
  externalBookingId: 'BROKER-1001', operatorId: 'operator-a', vehicleGroup: 'economy',
  pickupLocation: 'airport', dropoffLocation: 'airport',
  pickupAt: '2030-06-10T10:00:00Z', dropoffAt: '2030-06-12T10:00:00Z',
  customer: { name: 'Alex Example', email: 'alex@example.com' },
};

async function startServer(index: number) {
  const child = fork(new URL('../src/server.js', import.meta.url), [], {
    env: { ...process.env, DATABASE_URL: connectionString, PORT: '0', APP_NAME: `reservation-test-${index}` },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.push(child);
  let output = '';
  child.stdout?.on('data', (chunk) => { output += chunk; });
  child.stderr?.on('data', (chunk) => { output += chunk; });
  const port = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 10_000);
    child.once('message', (message) => { clearTimeout(timeout); resolve((message as { port: number }).port); });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Server exited ${code}: ${output}`)); });
  });
  urls.push(`http://127.0.0.1:${port}/reservations`);
}

before(async () => {
  await db.query('DROP TABLE IF EXISTS reservations; DROP TABLE IF EXISTS inventory_pools;');
  await db.query(await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8'));
  await db.query(await readFile(new URL('../../db/seed.sql', import.meta.url), 'utf8'));
  await startServer(0);
  await startServer(1);
});
beforeEach(async () => { await db.query('TRUNCATE reservations'); });
after(async () => {
  await Promise.all(children.map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }));
  await db.end();
});

async function post(body: unknown = base, server = 0, token: string | null = 'test-token-a') {
  const response = await fetch(urls[server], {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, body: await response.json() as any };
}
async function rows() { return (await db.query('SELECT * FROM reservations ORDER BY operator_id, external_booking_id')).rows; }
function error(result: Awaited<ReturnType<typeof post>>, status: number, code: string) {
  assert.equal(result.status, status);
  assert.deepEqual(Object.keys(result.body), ['error']);
  assert.deepEqual(Object.keys(result.body.error).sort(), ['code', 'message']);
  assert.equal(result.body.error.code, code);
  assert.equal(typeof result.body.error.message, 'string');
}

// Hold a DB lock until BOTH independent application processes are waiting.
// This proves actual contention, rather than relying on Promise.all timing.
async function race(payloads: Booking[], kind: 'identity' | 'pool') {
  const blocker = await db.connect();
  let pending: Promise<Awaited<ReturnType<typeof post>>>[] = [];
  try {
    await blocker.query('BEGIN');
    if (kind === 'identity') {
      await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify([payloads[0].operatorId, payloads[0].externalBookingId])]);
    } else {
      await blocker.query("SELECT 1 FROM inventory_pools WHERE operator_id = 'operator-a' AND vehicle_group = 'economy' FOR UPDATE");
    }
    pending = payloads.map((body, index) => post(body, index));
    const deadline = Date.now() + 4000;
    let waiting = 0;
    while (Date.now() < deadline) {
      const state = await db.query(`SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE application_name IN ('reservation-test-0', 'reservation-test-1') AND wait_event_type = 'Lock'`);
      waiting = state.rows[0].count;
      if (waiting === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(waiting, 2, 'Both server processes must reach a database lock wait');
    await blocker.query('COMMIT');
    return await Promise.all(pending);
  } finally {
    await blocker.query('ROLLBACK');
    await Promise.allSettled(pending);
    blocker.release();
  }
}

test('201 persists every field; 200 replay across processes returns original ID', async () => {
  const created = await post();
  assert.equal(created.status, 201);
  assert.match(created.body.reservationId, /^[0-9a-f-]{36}$/);
  assert.equal(created.body.externalBookingId, base.externalBookingId);
  assert.equal(created.body.operatorId, 'operator-a');
  const original = await rows();
  assert.equal(original.length, 1);
  assert.equal(original[0].id, created.body.reservationId);
  assert.equal(original[0].operator_id, base.operatorId);
  assert.equal(original[0].external_booking_id, base.externalBookingId);
  assert.equal(original[0].vehicle_group, base.vehicleGroup);
  assert.equal(original[0].pickup_location, base.pickupLocation);
  assert.equal(original[0].dropoff_location, base.dropoffLocation);
  assert.equal(original[0].pickup_at.toISOString(), '2030-06-10T10:00:00.000Z');
  assert.equal(original[0].dropoff_at.toISOString(), '2030-06-12T10:00:00.000Z');
  assert.equal(original[0].customer_name, base.customer.name);
  assert.equal(original[0].customer_email, base.customer.email);
  const replay = await post(base, 1);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, created.body);
  assert.deepEqual(await rows(), original);
});

test('setup can run twice on populated tables without changing reservations or duplicating pools', async () => {
  assert.equal((await post()).status, 201);
  const original = await rows();
  const setup = fileURLToPath(new URL('../../scripts/setup-db.mjs', import.meta.url));
  for (let attempt = 0; attempt < 2; attempt++) {
    await promisify(execFile)(process.execPath, [setup], {
      env: { ...process.env, DATABASE_URL: connectionString },
    });
    assert.deepEqual(await rows(), original);
    const inventory = await db.query('SELECT * FROM inventory_pools ORDER BY operator_id, vehicle_group');
    assert.deepEqual(inventory.rows, [
      { operator_id: 'operator-a', vehicle_group: 'compact', location: 'airport' },
      { operator_id: 'operator-a', vehicle_group: 'economy', location: 'airport' },
      { operator_id: 'operator-b', vehicle_group: 'economy', location: 'airport' },
    ]);
  }
});

test('concurrent different IDs for one pool: one 201 and one NO_AVAILABILITY', async () => {
  const results = await race([base, { ...base, externalBookingId: 'BROKER-1002' }], 'pool');
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
  error(results.find(r => r.status === 409)!, 409, 'NO_AVAILABILITY');
  const persisted = await rows();
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].id, results.find(r => r.status === 201)!.body.reservationId);
});

test('concurrent identical requests: one 201 and one 200 with same ID', async () => {
  const results = await race([base, base], 'identity');
  assert.deepEqual(results.map(r => r.status).sort(), [200, 201]);
  assert.deepEqual(results[0].body, results[1].body);
  const persisted = await rows();
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].id, results[0].body.reservationId);
});

test('concurrent reuse across groups: exactly one booking and IDEMPOTENCY_CONFLICT', async () => {
  const payloads = [base, { ...base, vehicleGroup: 'compact' }];
  const results = await race(payloads, 'identity');
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
  error(results.find(r => r.status === 409)!, 409, 'IDEMPOTENCY_CONFLICT');
  const persisted = await rows();
  assert.equal(persisted.length, 1);
  const winner = results.findIndex(r => r.status === 201);
  assert.equal(persisted[0].id, results[winner].body.reservationId);
  assert.equal(persisted[0].vehicle_group, payloads[winner].vehicleGroup);
});

test('tenants use same booking ID and dates independently; replay cannot expose the other ID', async () => {
  const b = { ...base, operatorId: 'operator-b' };
  const [aResult, bResult] = await Promise.all([post(), post(b, 1, 'test-token-b')]);
  assert.equal(aResult.status, 201);
  assert.equal(bResult.status, 201);
  assert.notEqual(aResult.body.reservationId, bResult.body.reservationId);
  assert.equal((await post(base, 1)).body.reservationId, aResult.body.reservationId);
  assert.equal((await post(b, 0, 'test-token-b')).body.reservationId, bResult.body.reservationId);
  error(await post(b, 0), 403, 'FORBIDDEN');
  error(await post(base, 1, 'test-token-b'), 403, 'FORBIDDEN');
  assert.deepEqual((await rows()).map(r => r.operator_id), ['operator-a', 'operator-b']);
});

test('groups are independent for different booking IDs', async () => {
  const results = await Promise.all([post(), post({ ...base, externalBookingId: 'compact-id', vehicleGroup: 'compact' }, 1)]);
  assert.deepEqual(results.map(r => r.status), [201, 201]);
  assert.equal((await rows()).length, 2);
});

test('half-open boundaries allow adjacent bookings; partial overlap and both containments conflict', async () => {
  assert.equal((await post()).status, 201);
  const periods = [
    ['2030-06-09T10:00:00Z', '2030-06-11T10:00:00Z'],
    ['2030-06-11T10:00:00Z', '2030-06-13T10:00:00Z'],
    ['2030-06-10T11:00:00Z', '2030-06-12T09:00:00Z'],
    ['2030-06-09T10:00:00Z', '2030-06-13T10:00:00Z'],
    [base.pickupAt, base.dropoffAt],
  ];
  for (const [index, [pickupAt, dropoffAt]] of periods.entries()) {
    error(await post({ ...base, externalBookingId: `overlap-${index}`, pickupAt, dropoffAt }), 409, 'NO_AVAILABILITY');
  }
  assert.equal((await rows()).length, 1);
  assert.equal((await post({ ...base, externalBookingId: 'before', pickupAt: '2030-06-09T10:00:00Z', dropoffAt: base.pickupAt })).status, 201);
  assert.equal((await post({ ...base, externalBookingId: 'after', pickupAt: base.dropoffAt, dropoffAt: '2030-06-13T10:00:00Z' })).status, 201);
  assert.equal((await rows()).length, 3);
});

test('each changeable non-key business field conflicts, taking precedence over availability', async () => {
  await post();
  const original = await rows();
  const changes = [
    { vehicleGroup: 'compact' },
    { pickupAt: '2030-06-10T10:00:01Z' },
    { dropoffAt: '2030-06-12T10:00:01Z' },
    { customer: { ...base.customer, name: 'Alex Example ' } },
    { customer: { ...base.customer, email: 'Alex@example.com' } },
  ];
  for (const change of changes) error(await post({ ...base, ...change }), 409, 'IDEMPOTENCY_CONFLICT');
  assert.deepEqual(await rows(), original);
  // Both locations have only one valid value; changing either is invalid input.
  for (const field of ['pickupLocation', 'dropoffLocation']) error(await post({ ...base, [field]: 'downtown' }), 400, 'INVALID_REQUEST');
});

test('JSON key order and equivalent offset timestamps replay the original', async () => {
  const first = await post();
  const reversed = Object.fromEntries(Object.entries({ ...base,
    pickupAt: '2030-06-10T15:30:00+05:30', dropoffAt: '2030-06-12T06:00:00-04:00',
    customer: { email: base.customer.email, name: base.customer.name },
  }).reverse());
  const replay = await post(reversed, 1);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, first.body);
  assert.equal((await rows()).length, 1);
});

test('microseconds remain distinct for idempotency, ordering, and adjacency', async () => {
  const precise = { ...base, pickupAt: '2030-06-10T10:00:00.000001Z', dropoffAt: '2030-06-10T10:00:00.000003Z' };
  const created = await post(precise);
  assert.equal(created.status, 201);
  const replay = await post({ ...precise, pickupAt: '2030-06-10T11:00:00.000001+01:00' }, 1);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.reservationId, created.body.reservationId);
  error(await post({ ...precise, pickupAt: '2030-06-10T10:00:00.000002Z' }), 409, 'IDEMPOTENCY_CONFLICT');
  error(await post({ ...precise, externalBookingId: 'overlap', pickupAt: '2030-06-10T10:00:00.000002Z' }), 409, 'NO_AVAILABILITY');
  assert.equal((await post({ ...precise, externalBookingId: 'adjacent', pickupAt: precise.dropoffAt, dropoffAt: '2030-06-10T10:00:00.000004Z' })).status, 201);
  const stored = await db.query("SELECT to_char(pickup_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS time FROM reservations WHERE external_booking_id = $1", [base.externalBookingId]);
  assert.equal(stored.rows[0].time, '2030-06-10 10:00:00.000001');
  assert.equal((await rows()).length, 2);
});

test('availability rejection does not consume key; valid changed retry can then succeed', async () => {
  await post();
  const rejected = { ...base, externalBookingId: 'retry-me' };
  error(await post(rejected), 409, 'NO_AVAILABILITY');
  assert.equal((await rows()).length, 1);
  assert.equal((await post({ ...rejected, vehicleGroup: 'compact' }, 1)).status, 201);
  assert.equal((await rows()).length, 2);
});

test('invalid requests never consume a key; required fields, types, formats and pools', async () => {
  const invalidBodies: unknown[] = [null, [], 'hello', {}, { ...base, customer: null }];
  for (const field of Object.keys(base)) {
    const missing: Record<string, unknown> = { ...base };
    delete missing[field];
    invalidBodies.push(missing, { ...base, [field]: 42 });
  }
  for (const field of ['externalBookingId', 'operatorId', 'vehicleGroup', 'pickupLocation', 'dropoffLocation']) invalidBodies.push({ ...base, [field]: '   ' });
  for (const customer of [{ name: '', email: 'x@y.com' }, { name: 'Alex', email: 'bad' }, { name: 'Alex' }, { email: 'a@b.com' }, { name: 42, email: 'a@b.com' }]) invalidBodies.push({ ...base, customer });
  for (const pickupAt of ['2030-02-30T10:00:00Z', '2030-06-10T10:00:00', '2030-06-10T24:00:00Z', '2030-06-10T10:00:00+24:00', '2030-06-10T10:00:60Z', '2030-06-10T10:00:00.1234567Z', '0000-01-01T00:00:00Z', base.dropoffAt, '2031-01-01T00:00:00Z']) invalidBodies.push({ ...base, pickupAt });
  invalidBodies.push({ ...base, vehicleGroup: 'luxury' }, { ...base, externalBookingId: 'bad\0id' },
    { ...base, externalBookingId: 'x'.repeat(257) }, { ...base, externalBookingId: '\ud800' });
  for (const body of invalidBodies) error(await post(body), 400, 'INVALID_REQUEST');
  error(await post({ ...base, operatorId: 'operator-b', vehicleGroup: 'compact' }, 1, 'test-token-b'), 400, 'INVALID_REQUEST');
  assert.equal((await rows()).length, 0);
  assert.equal((await post()).status, 201);
});

test('missing/invalid tokens and cross-tenant body fail without writes', async () => {
  for (const token of [null, 'wrong', 'toString', '__proto__']) error(await post(base, 0, token), 401, 'UNAUTHORIZED');
  error(await post({ ...base, operatorId: 'operator-b' }), 403, 'FORBIDDEN');
  assert.equal((await rows()).length, 0);
});

test('malformed JSON, wrong content type, oversized body use required error envelope', async () => {
  for (const [body, contentType] of [['{', 'application/json'], [JSON.stringify(base), 'text/plain'], [JSON.stringify({ ...base, extra: 'x'.repeat(17000) }), 'application/json']]) {
    const result = await fetch(urls[0], { method: 'POST', headers: { authorization: 'Bearer test-token-a', 'content-type': contentType }, body });
    error({ status: result.status, body: await result.json() }, 400, 'INVALID_REQUEST');
  }
  assert.equal((await rows()).length, 0);
});

test('past dates and leap days are allowed; other strings retain exact identity', async () => {
  const past = { ...base, pickupAt: '2020-02-29T10:00:00Z', dropoffAt: '2020-03-01T10:00:00Z' };
  assert.equal((await post(past)).status, 201);
  assert.equal((await post({ ...past, externalBookingId: `${past.externalBookingId} `, vehicleGroup: 'compact' })).status, 201);
  assert.equal((await rows()).length, 2);
});

test('DB exclusion and uniqueness protect persisted data even if application checks are bypassed', async () => {
  await post();
  const original = await rows();
  await assert.rejects(db.query(`INSERT INTO reservations (operator_id, external_booking_id, vehicle_group, pickup_location, dropoff_location, pickup_at, dropoff_at, customer_name, customer_email)
    SELECT operator_id, 'direct-overlap', vehicle_group, pickup_location, dropoff_location, pickup_at, dropoff_at, customer_name, customer_email FROM reservations`), { code: '23P01' });
  await assert.rejects(db.query(`INSERT INTO reservations (operator_id, external_booking_id, vehicle_group, pickup_location, dropoff_location, pickup_at, dropoff_at, customer_name, customer_email)
    SELECT operator_id, external_booking_id, 'compact', pickup_location, dropoff_location, pickup_at, dropoff_at, customer_name, customer_email FROM reservations`), { code: '23505' });
  assert.deepEqual(await rows(), original);
});

test('infrastructure connection failure produces a sanitized 503', async () => {
  // Real pg client, pointed at a guaranteed closed local port after releasing it.
  const { createServer } = await import('node:net');
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address() as { port: number };
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const badDb = new pg.Pool({ host: '127.0.0.1', port: address.port, connectionTimeoutMillis: 500 });
  const server = createApp(badDb).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const port = (server.address() as { port: number }).port;
    const result = await fetch(`http://127.0.0.1:${port}/reservations`, { method: 'POST', headers: { authorization: 'Bearer test-token-a', 'content-type': 'application/json' }, body: JSON.stringify(base) });
    const body = await result.json() as any;
    error({ status: result.status, body }, 503, 'SERVICE_UNAVAILABLE');
    assert.doesNotMatch(JSON.stringify(body), /ECONNREFUSED|SELECT|postgres|password/i);
    assert.equal((await rows()).length, 0);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await badDb.end();
  }
});
