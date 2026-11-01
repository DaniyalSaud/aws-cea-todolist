import { createApp } from './app.js';
import { readConfig } from './config.js';
import { createPool } from './database.js';
import { migrate } from './migrate.js';

try {
  const config = readConfig();
  const pool = createPool(config);
  try {
    if (config.RUN_MIGRATIONS) await migrate(pool);
    await pool.query('SELECT 1');
  } catch (error) {
    await pool.end();
    throw error;
  }
  const server = createApp(pool, config).listen(config.PORT, '0.0.0.0', () => {
    console.log(`Todo API listening on port ${config.PORT}.`);
  });
  server.on('error', async (error) => {
    console.error('Unable to start API server.', { code: (error as NodeJS.ErrnoException).code });
    await pool.end();
    process.exitCode = 1;
  });
  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('Shutting down API.');
    const timeout = setTimeout(() => process.exit(1), 15_000);
    timeout.unref();
    server.close(() => {
      void pool.end().then(() => {
        clearTimeout(timeout);
        process.exit(0);
      });
    });
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
} catch (error) {
  console.error('API startup failed.', error instanceof Error ? error.message : 'Unknown error');
  process.exitCode = 1;
}
