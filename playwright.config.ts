import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:5174', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    { command: 'node scripts/e2e-server.mjs', url: 'http://127.0.0.1:3002/api/health', timeout: 120_000, reuseExistingServer: false },
    { command: 'npm run dev -w frontend -- --port 5174', url: 'http://127.0.0.1:5174', timeout: 60_000, reuseExistingServer: false, env: { API_PROXY_TARGET: 'http://127.0.0.1:3002', VITE_API_URL: '' } }
  ]
});
