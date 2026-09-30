import pg from 'pg';
import { createApp } from './app.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 5000,
  application_name: process.env.APP_NAME ?? 'reservations',
});
pool.on('error', () => console.error('Idle database connection failed.'));
const server = createApp(pool).listen(Number(process.env.PORT ?? 3000), '127.0.0.1', () => {
  const address = server.address();
  if (address && typeof address !== 'string') {
    console.log(`Listening on http://127.0.0.1:${address.port}`);
    process.send?.({ port: address.port });
  }
});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  server.close(() => { void pool.end().then(() => process.exit(0)); });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
