BEGIN;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- One row represents exactly one vehicle. No capacity arithmetic is needed.
CREATE TABLE IF NOT EXISTS inventory_pools (
  operator_id text NOT NULL,
  vehicle_group text NOT NULL,
  location text NOT NULL CHECK (location = 'airport'),
  PRIMARY KEY (operator_id, vehicle_group, location)
);

CREATE TABLE IF NOT EXISTS reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id text NOT NULL,
  external_booking_id text NOT NULL CHECK (btrim(external_booking_id) <> ''),
  vehicle_group text NOT NULL,
  pickup_location text NOT NULL,
  dropoff_location text NOT NULL CHECK (dropoff_location = 'airport'),
  pickup_at timestamptz NOT NULL,
  dropoff_at timestamptz NOT NULL,
  customer_name text NOT NULL CHECK (btrim(customer_name) <> ''),
  customer_email text NOT NULL CHECK (btrim(customer_email) <> ''),
  CONSTRAINT valid_period CHECK (isfinite(pickup_at) AND isfinite(dropoff_at) AND pickup_at < dropoff_at),
  CONSTRAINT booking_identity UNIQUE (operator_id, external_booking_id),
  FOREIGN KEY (operator_id, vehicle_group, pickup_location)
    REFERENCES inventory_pools (operator_id, vehicle_group, location),
  CONSTRAINT no_overlapping_reservations EXCLUDE USING gist (
    operator_id WITH =,
    vehicle_group WITH =,
    pickup_location WITH =,
    tstzrange(pickup_at, dropoff_at, '[)') WITH &&
  )
);
COMMIT;
