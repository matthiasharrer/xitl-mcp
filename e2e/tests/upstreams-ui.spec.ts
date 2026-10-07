// Settings > Upstreams on a phone: TC-08.
import { test, expect, type Page } from '@playwright/test';
import { uniq } from '../support/db.js';

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
}

test('TC-08 Einstellungen: Upstream hinzufügen, bearbeiten, löschen (mit Bestätigung), kein horizontales Scrollen', async ({
  page,
  request,
}) => {
  const name = uniq('Haushalt UI').replace(/[^A-Za-z0-9 -]/g, '');
  await page.goto('/');
  await page.getByRole('link', { name: 'Einstellungen' }).click();
  await expect(page).toHaveURL(/#\/einstellungen$/);
  await expect(page.getByRole('heading', { name: 'Upstreams' })).toBeVisible();
  await noHorizontalScroll(page);

  // add
  await page.getByRole('button', { name: 'Upstream hinzufügen' }).click();
  const sheet = page.getByRole('dialog', { name: 'Upstream hinzufügen' });
  await expect(sheet).toBeVisible();
  await sheet.getByLabel('Name').fill(name);
  const slug = await sheet.getByLabel('Slug').inputValue();
  expect(slug).toMatch(/^[a-z0-9][a-z0-9-]{0,31}$/); // derived from the name
  await sheet.getByLabel('URL').fill('https://haushalt.example/mcp');
  await sheet.getByLabel('Beschreibung').fill('Aufgaben im Haushalt');
  await sheet.getByRole('radio', { name: 'Erlauben' }).check({ force: true });
  await noHorizontalScroll(page);
  await sheet.getByRole('button', { name: 'Hinzufügen' }).click();
  await expect(sheet).toBeHidden();

  const item = page.locator('li.item[data-slug]', { hasText: name });
  await expect(item).toBeVisible();
  await expect(item).toContainText(slug);
  await expect(item).toContainText('https://haushalt.example/mcp');
  await expect(item).toContainText('Nicht verbunden');
  await noHorizontalScroll(page);

  // a duplicate slug is refused with the server's German message, sheet stays open
  await page.getByRole('button', { name: 'Upstream hinzufügen' }).click();
  await sheet.getByLabel('Name').fill('Doppelt');
  await sheet.getByLabel('Slug').fill(slug);
  await sheet.getByLabel('URL').fill('https://x.example/mcp');
  await sheet.getByRole('button', { name: 'Hinzufügen' }).click();
  await expect(sheet.getByRole('alert')).toContainText('Slug');
  await sheet.getByRole('button', { name: 'Schließen' }).click();
  await expect(sheet).toBeHidden();

  // edit the description
  await item.getByRole('button', { name: 'Bearbeiten' }).click();
  const edit = page.getByRole('dialog', { name: 'Upstream bearbeiten' });
  await expect(edit.getByLabel('Beschreibung')).toHaveValue('Aufgaben im Haushalt');
  await edit.getByLabel('Beschreibung').fill('Neue Beschreibung');
  await edit.getByRole('button', { name: 'Speichern' }).click();
  await expect(edit).toBeHidden();
  const list = await (await request.get('/api/upstreams', { headers: { 'Remote-User': 'matthias' } })).json();
  const row = list.find((u: any) => u.slug === slug);
  expect(row.description).toBe('Neue Beschreibung');
  expect(row.defaultPolicy).toBe('ALLOW');

  // delete: cancel keeps it, confirm removes it
  await item.getByRole('button', { name: 'Löschen' }).click();
  const confirm = page.getByRole('dialog', { name: new RegExp(`„${name}“ löschen\\?`) });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Abbrechen' }).click();
  await expect(confirm).toBeHidden();
  await expect(item).toBeVisible();

  await item.getByRole('button', { name: 'Löschen' }).click();
  await confirm.getByRole('button', { name: 'Löschen' }).click();
  await expect(page.locator('li.item[data-slug]', { hasText: name })).toHaveCount(0);
  await noHorizontalScroll(page);
});
