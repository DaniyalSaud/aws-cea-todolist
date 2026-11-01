import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';

const migrationsDirectory = new URL('../migrations/', import.meta.url);

export async function migrate(pool: pg.Pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Transaction-scoped lock prevents replicas from running the same migration at once.
    await client.query('SELECT pg_advisory_xact_lock(78423109)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const applied = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const names = new Set(applied.rows.map((row) => row.name));
    const files = (await readdir(migrationsDirectory)).filter((file) => file.endsWith('.sql')).sort();
    for (const file of files) {
      if (names.has(file)) continue;
      await client.query(await readFile(new URL(file, migrationsDirectory), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
