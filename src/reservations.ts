import type { Pool, PoolClient } from 'pg';
import { ApiError, invalid } from './errors.js';
import type { Booking } from './validation.js';

export async function reserve(pool: Pool, operatorId: string, booking: Booking) {
  const client = await pool.connect();
  let discard = false;
  try {
    // READ COMMITTED gives the SELECT after a lock wait a fresh snapshot.
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '10s'");

    // Key excludes group/dates; JSON array encoding avoids delimiter ambiguity.
    // Hash collisions only cause extra waiting, never identity equivalence.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      JSON.stringify([operatorId, booking.externalBookingId]),
    ]);

    const values = [operatorId, booking.externalBookingId, booking.vehicleGroup,
      booking.pickupLocation, booking.dropoffLocation, booking.pickupAt,
      booking.dropoffAt, booking.customer.name, booking.customer.email];

    // Validate supported inventory before treating a payload as a valid retry.
    const inventory = await client.query(
      'SELECT 1 FROM inventory_pools WHERE operator_id = $1 AND vehicle_group = $2 AND location = $3',
      [operatorId, booking.vehicleGroup, booking.pickupLocation],
    );
    if (!inventory.rowCount) invalid('Unsupported inventory pool.');

    const existing = await client.query<{ id: string; identical: boolean }>(`
      SELECT id, ROW(vehicle_group, pickup_location, dropoff_location, pickup_at,
        dropoff_at, customer_name, customer_email) =
        ROW($3::text, $4::text, $5::text, $6::timestamptz, $7::timestamptz, $8::text, $9::text) AS identical
      FROM reservations WHERE operator_id = $1 AND external_booking_id = $2`, values);

    if (existing.rowCount) {
      if (!existing.rows[0].identical) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This booking ID already has a different payload.');
      await client.query('COMMIT');
      return { status: 200, body: response(existing.rows[0].id, operatorId, booking) };
    }

    // Always acquire identity lock BEFORE pool lock. Serialize new bookings per
    // pool, avoiding competing exclusion-index insert deadlocks. Replays skip it.
    await lockPool(client, operatorId, booking);
    const inserted = await client.query<{ id: string }>(`
      INSERT INTO reservations (operator_id, external_booking_id, vehicle_group,
        pickup_location, dropoff_location, pickup_at, dropoff_at, customer_name, customer_email)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, values);
    await client.query('COMMIT');
    return { status: 201, body: response(inserted.rows[0].id, operatorId, booking) };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { discard = true; }
    const dbError = error as { code?: string; constraint?: string };
    if (dbError.code === '23P01' && dbError.constraint === 'no_overlapping_reservations') {
      throw new ApiError(409, 'NO_AVAILABILITY', 'No vehicle is available for that period.');
    }
    throw error;
  } finally {
    client.release(discard);
  }
}

async function lockPool(client: PoolClient, operatorId: string, booking: Booking) {
  await client.query(`SELECT 1 FROM inventory_pools
    WHERE operator_id = $1 AND vehicle_group = $2 AND location = $3 FOR UPDATE`,
  [operatorId, booking.vehicleGroup, booking.pickupLocation]);
}

function response(id: string, operatorId: string, booking: Booking) {
  return { reservationId: id, externalBookingId: booking.externalBookingId, operatorId };
}
