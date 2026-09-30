import { invalid } from './errors.js';

export interface Booking {
  externalBookingId: string;
  operatorId: string;
  vehicleGroup: string;
  pickupLocation: string;
  dropoffLocation: string;
  pickupAt: string;
  dropoffAt: string;
  customer: { name: string; email: string };
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${field} must be an object.`);
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  // Preserve original strings: trimming is only used to detect blank input.
  if (typeof value !== 'string' || !value.trim() || value.length > 256 ||
      value.includes('\0') || /[\uD800-\uDFFF]/u.test(value)) {
    invalid(`${field} must be a nonblank valid Unicode string of at most 256 characters without NUL characters.`);
  }
  return value;
}

function timestamp(value: unknown, field: string): { text: string; micros: bigint } {
  const text = string(value, field);
  // PostgreSQL's timestamp precision is microseconds. Never silently truncate it
  // through a JavaScript Date when deciding booking equality or overlap.
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/i.exec(text);
  if (!match) invalid(`${field} must be an ISO timestamp with an explicit timezone and at most six fractional digits.`);
  const [, y, mo, d, h, mi, s, fraction = '', zone] = match;
  const [year, month, day, hour, minute, second] = [y, mo, d, h, mi, s].map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (year < 1 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day || date.getUTCHours() !== hour ||
      date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) invalid(`${field} is not a valid calendar timestamp.`);
  let offsetMinutes = 0;
  if (zone.toUpperCase() !== 'Z') {
    const zh = Number(zone.slice(1, 3));
    const zm = Number(zone.slice(4, 6));
    if (zh > 23 || zm > 59) invalid(`${field} has an invalid timezone offset.`);
    offsetMinutes = (zh * 60 + zm) * (zone[0] === '+' ? 1 : -1);
  }
  date.setTime(date.getTime() - offsetMinutes * 60_000);
  if (date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) invalid(`${field} is out of range.`);
  const fractionalMicros = fraction.padEnd(6, '0');
  return {
    text: `${date.toISOString().slice(0, 19)}.${fractionalMicros}Z`,
    micros: BigInt(date.getTime()) * 1000n + BigInt(fractionalMicros),
  };
}

export function validateBooking(value: unknown): Booking {
  const body = object(value, 'Request');
  const customer = object(body.customer, 'customer');
  const pickup = timestamp(body.pickupAt, 'pickupAt');
  const dropoff = timestamp(body.dropoffAt, 'dropoffAt');
  if (pickup.micros >= dropoff.micros) invalid('pickupAt must precede dropoffAt.');
  const email = string(customer.email, 'customer.email');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) invalid('customer.email must be a valid email address.');
  const booking: Booking = {
    externalBookingId: string(body.externalBookingId, 'externalBookingId'),
    operatorId: string(body.operatorId, 'operatorId'),
    vehicleGroup: string(body.vehicleGroup, 'vehicleGroup'),
    pickupLocation: string(body.pickupLocation, 'pickupLocation'),
    dropoffLocation: string(body.dropoffLocation, 'dropoffLocation'),
    pickupAt: pickup.text,
    dropoffAt: dropoff.text,
    customer: { name: string(customer.name, 'customer.name'), email },
  };
  if (booking.pickupLocation !== 'airport' || booking.dropoffLocation !== 'airport') invalid('Both locations must be airport.');
  return booking;
}
