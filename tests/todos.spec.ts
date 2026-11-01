import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test.beforeEach(async ({ request }) => {
  const response = await request.get('/api/todos');
  for (const todo of (await response.json()).todos as { id: string }[]) await request.delete(`/api/todos/${todo.id}`);
});

test('adds, edits, completes, filters, reloads and deletes tasks', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'A fresh start.' })).toBeVisible();
  await page.getByRole('textbox', { name: 'New task' }).fill('Book a dentist appointment');
  await page.getByRole('button', { name: 'Add task' }).click();
  await expect(page.getByText('Book a dentist appointment', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'New task' }).fill('Go for a walk');
  await page.getByRole('textbox', { name: 'New task' }).press('Enter');
  await expect(page.getByText('Go for a walk', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit: Book a dentist appointment', exact: true }).click();
  await page.getByRole('textbox', { name: 'Edit task title' }).fill('Book a checkup');
  await page.getByRole('button', { name: 'Save task', exact: true }).click();
  await expect(page.getByText('Book a checkup', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Complete: Book a checkup', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Mark incomplete: Book a checkup', exact: true })).toBeChecked();
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
  await page.getByRole('button', { name: /^Active/ }).click();
  await expect(page.getByText('Go for a walk', { exact: true })).toBeVisible();
  await expect(page.getByText('Book a checkup', { exact: true })).toBeHidden();
  await page.getByRole('button', { name: /^Completed/ }).click();
  await expect(page.getByText('Book a checkup', { exact: true })).toBeVisible();
  await expect(page.getByText('Go for a walk', { exact: true })).toBeHidden();
  await page.reload();
  await expect(page.getByText('Book a checkup', { exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Mark incomplete: Book a checkup', exact: true })).toBeChecked();
  await page.getByRole('button', { name: 'Clear completed', exact: true }).click();
  await expect(page.getByText('Book a checkup', { exact: true })).toBeHidden();
  await expect(page.getByText('Go for a walk', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Delete: Go for a walk', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A fresh start.' })).toBeVisible();
});

test('preserves a draft when a save fails and recovers', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'A fresh start.' })).toBeVisible();
  await page.route('**/api/todos', (route) => route.request().method() === 'POST' ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Please try again.' }) }) : route.continue());
  await page.getByRole('textbox', { name: 'New task' }).fill('Keep this draft');
  await page.getByRole('button', { name: 'Add task' }).click();
  await expect(page.getByRole('alert')).toContainText('Please try again.');
  await expect(page.getByRole('textbox', { name: 'New task' })).toHaveValue('Keep this draft');
  await page.unroute('**/api/todos');
  await page.getByRole('button', { name: 'Add task' }).click();
  await expect(page.getByText('Keep this draft', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toBeHidden();
});

test('retries an initial connection failure', async ({ page }) => {
  await page.route('**/api/todos', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Connection unavailable.' }) }));
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('Connection unavailable.');
  await expect(page.getByRole('textbox', { name: 'New task' })).toBeDisabled();
  await page.unroute('**/api/todos');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { name: 'A fresh start.' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'New task' })).toBeEnabled();
});

test('handles long text, plain HTML and editing cancellation on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  const title = '<script>window.bad = true</script> ' + 'a'.repeat(150);
  await page.getByRole('textbox', { name: 'New task' }).fill(title);
  await page.getByRole('button', { name: 'Add task' }).click();
  await expect(page.getByText(title, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => Object.hasOwn(window, 'bad'))).toBe(false);
  await page.getByRole('button', { name: `Edit: ${title}`, exact: true }).click();
  await page.getByRole('textbox', { name: 'Edit task title' }).fill('Do not save this');
  await page.getByRole('textbox', { name: 'Edit task title' }).press('Escape');
  await expect(page.getByText(title, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/mobile.png', fullPage: true });
});

test('desktop layout renders without browser errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'A fresh start.' })).toBeVisible();
  for (const title of ['Make time for a morning walk', 'Plan something good for the weekend', 'Finish the little things']) {
    await page.getByRole('textbox', { name: 'New task' }).fill(title);
    await page.getByRole('button', { name: 'Add task' }).click();
    await expect(page.getByText(title, { exact: true })).toBeVisible();
  }
  await page.getByLabel('Attachment file: Plan something good for the weekend', { exact: true }).setInputFiles({ name: 'weekend-ideas.txt', mimeType: 'text/plain', buffer: Buffer.from('A few ideas for the weekend') });
  await expect(page.getByRole('button', { name: 'Download attachment: weekend-ideas.txt', exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Complete: Make time for a morning walk', exact: true }).click();
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '33');
  expect(errors).toEqual([]);
  await page.screenshot({ path: 'test-results/desktop.png', fullPage: true });
});

test('attaches, downloads, replaces and removes files', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'A fresh start.' })).toBeVisible();
  await page.getByRole('textbox', { name: 'New task' }).fill('Review the project notes');
  await page.getByRole('button', { name: 'Add task' }).click();
  await expect(page.getByText('Review the project notes', { exact: true })).toBeVisible();
  await page.getByLabel('Attachment file: Review the project notes', { exact: true }).setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Project notes for tomorrow') });
  await expect(page.getByRole('button', { name: 'Download attachment: notes.txt', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Download attachment: notes.txt', exact: true })).toBeVisible();
  const downloadReady = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download attachment: notes.txt', exact: true }).click();
  const download = await downloadReady;
  expect(download.suggestedFilename()).toBe('notes.txt');
  expect(await readFile((await download.path())!, 'utf8')).toBe('Project notes for tomorrow');
  await page.getByLabel('Attachment file: Review the project notes', { exact: true }).setInputFiles({ name: 'updated.txt', mimeType: 'text/plain', buffer: Buffer.from('Updated project notes') });
  await expect(page.getByRole('button', { name: 'Download attachment: updated.txt', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download attachment: notes.txt', exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'Remove attachment: updated.txt', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Download attachment: updated.txt', exact: true })).toBeHidden();
});

test('preserves an attachment when a replacement upload fails', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'A fresh start.' })).toBeVisible();
  await page.getByRole('textbox', { name: 'New task' }).fill('Keep my notes');
  await page.getByRole('button', { name: 'Add task' }).click();
  await expect(page.getByText('Keep my notes', { exact: true })).toBeVisible();
  const input = page.getByLabel('Attachment file: Keep my notes', { exact: true });
  await input.setInputFiles({ name: 'original.txt', mimeType: 'text/plain', buffer: Buffer.from('Original notes') });
  await expect(page.getByRole('button', { name: 'Download attachment: original.txt', exact: true })).toBeVisible();
  await page.route('**/api/todos/*/attachment', (route) => route.request().method() === 'POST' ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'File storage is temporarily unavailable.' }) }) : route.continue());
  await input.setInputFiles({ name: 'replacement.txt', mimeType: 'text/plain', buffer: Buffer.from('Replacement') });
  await expect(page.getByRole('alert')).toContainText('File storage is temporarily unavailable.');
  await expect(page.getByRole('button', { name: 'Download attachment: original.txt', exact: true })).toBeVisible();
});
