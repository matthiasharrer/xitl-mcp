#!/usr/bin/env node
// Rasterizes apps/web/public/icon.svg into the PWA's PNG icons (ADR-0009) with
// the Playwright Chromium we already have (no extra dependency, no network).
// Run after changing icon.svg:
//   PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright node scripts/icons.mjs
// Outputs (apps/web/public/): icon-192.png, icon-512.png (as drawn, rounded,
// transparent corners), maskable-icon-512.png and apple-touch-icon.png (180,
// full-bleed background; the glyph inside the maskable safe zone).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pub = path.join(root, 'apps/web/public');
const svg = fs.readFileSync(path.join(pub, 'icon.svg'), 'utf8');
const BG = '#3b4a8c';
const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

const jobs = [
  { file: 'icon-192.png', size: 192, fullBleed: false, scale: 1 },
  { file: 'icon-512.png', size: 512, fullBleed: false, scale: 1 },
  // Maskable: the platform crops to a circle/squircle; keep the glyph in the
  // central 80 % safe zone on a full background.
  { file: 'maskable-icon-512.png', size: 512, fullBleed: true, scale: 0.8 },
  // iOS rounds the corners itself and shows transparency as black.
  { file: 'apple-touch-icon.png', size: 180, fullBleed: true, scale: 1 },
];

const browser = await chromium.launch();
try {
  for (const job of jobs) {
    const page = await browser.newPage({ viewport: { width: job.size, height: job.size }, deviceScaleFactor: 1 });
    const inner = Math.round(job.size * job.scale);
    await page.setContent(
      `<html><body style="margin:0;width:${job.size}px;height:${job.size}px;display:grid;place-items:center;` +
        `background:${job.fullBleed ? BG : 'transparent'}">` +
        `<img src="${dataUrl}" width="${inner}" height="${inner}" style="display:block;${job.fullBleed ? 'border-radius:0' : ''}"></body></html>`,
    );
    await page.waitForFunction(() => document.images[0]?.complete);
    await page.screenshot({ path: path.join(pub, job.file), omitBackground: !job.fullBleed });
    await page.close();
    console.log(`wrote ${job.file}`);
  }
} finally {
  await browser.close();
}
