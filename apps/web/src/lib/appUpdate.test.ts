// TC-212…215 (unit): which entry script an index.html loads (ADR-0035).
import { describe, expect, it } from 'vitest';
import { entryScript } from './appUpdate.svelte';

describe('entryScript', () => {
  it('finds the hashed entry script of a Vite build', () => {
    const html = `<!doctype html><html><head><meta charset="UTF-8" />
      <script type="module" crossorigin src="/assets/index-AbC123.js"></script>
      <link rel="stylesheet" crossorigin href="/assets/index-Zz9.css"></head><body><div id="app"></div></body></html>`;
    expect(entryScript(html)).toBe('/assets/index-AbC123.js');
  });
  it('an absolute URL reduces to its pathname', () => {
    expect(entryScript('<script type="module" src="https://app.example.de/assets/index-Q1.js"></script>')).toBe(
      '/assets/index-Q1.js',
    );
  });
  it('the Vite dev html has no hashed bundle', () => {
    expect(
      entryScript('<script type="module" src="/@vite/client"></script><script type="module" src="/src/main.ts"></script>'),
    ).toBeNull();
  });
  it('a login page without assets is not a build', () => {
    expect(
      entryScript('<html><body><form action="/api/firstfactor"></form><script src="/static/login.js"></script></body></html>'),
    ).toBeNull();
  });
});
