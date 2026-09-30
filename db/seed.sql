INSERT INTO inventory_pools (operator_id, vehicle_group, location) VALUES
  ('operator-a', 'economy', 'airport'),
  ('operator-a', 'compact', 'airport'),
  ('operator-b', 'economy', 'airport')
ON CONFLICT DO NOTHING;
