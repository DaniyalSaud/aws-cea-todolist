import { readConfig } from './config.js';
import { createPool } from './database.js';
import { migrate } from './migrate.js';

let pool;
try {
  pool = createPool(readConfig());
  await migrate(pool);
  console.log('Database migrations are up to date.');
} catch (error) {
  console.error('Database migration failed.', error instanceof Error ? error.message : 'Unknown error');
  process.exitCode = 1;
} finally {
  await pool?.end();
}
