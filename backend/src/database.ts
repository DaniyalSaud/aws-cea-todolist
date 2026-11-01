import { readFileSync } from 'node:fs';
import pg from 'pg';
import type { Config } from './config.js';

export function createPool(config: Config) {
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    ssl: config.DB_SSL ? {
      rejectUnauthorized: true,
      ...(config.DB_SSL_CA_PATH ? { ca: readFileSync(config.DB_SSL_CA_PATH, 'utf8') } : {})
    } : false,
    max: config.DB_POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    application_name: 'everyday-todo'
  });
  pool.on('error', (error) => console.error('Unexpected idle database connection error.', {
    code: (error as NodeJS.ErrnoException).code ?? 'unknown'
  }));
  return pool;
}
