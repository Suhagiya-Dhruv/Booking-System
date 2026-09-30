import { readFile } from 'node:fs/promises';
import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required. Copy .env.example to .env.');
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
try {
  await client.connect();
  for (const file of ['schema.sql', 'seed.sql']) {
    await client.query(await readFile(new URL(`../db/${file}`, import.meta.url), 'utf8'));
  }
  console.log('Schema ready; three inventory pools ensured. Existing reservations preserved.');
} finally {
  await client.end();
}
