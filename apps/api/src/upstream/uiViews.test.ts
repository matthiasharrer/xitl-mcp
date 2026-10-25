// ADR-0038 slices 2–3 (unit parts of TC-243…249): the pure MCP Apps helpers.
import { describe, expect, test } from 'vitest';
import {
  UI_MIME,
  appOnlyFromUiMeta,
  isUiUri,
  pageCsp,
  pageHash,
  parseCsp,
  shownViews,
  splitUnifiedUiUri,
  uiMetaText,
  uiResourceUriOf,
  uiState,
  unifiedUiUri,
  validatePage,
  viewShown,
  withUnifiedUiUri,
  type ViewRow,
} from './uiViews.js';

const VIEW = 'ui://fake/chart.html';
const withMeta = (_meta: unknown) => ({ name: 't', inputSchema: { type: 'object' }, _meta }) as never;

describe('view reference (TC-243)', () => {
  test('isUiUri: ui:// strings up to 512 chars, no whitespace', () => {
    expect(isUiUri(VIEW)).toBe(true);
    expect(isUiUri('ui://')).toBe(false);
    expect(isUiUri('http://x/a.html')).toBe(false);
    expect(isUiUri('ui://a b')).toBe(false);
    expect(isUiUri('ui://a\u0000b')).toBe(false);
    expect(isUiUri(`ui://${'x'.repeat(507)}`)).toBe(true);
    expect(isUiUri(`ui://${'x'.repeat(508)}`)).toBe(false);
    expect(isUiUri(42)).toBe(false);
  });

  test('ui.resourceUri wins over the flat key; the flat key alone counts', () => {
    expect(uiResourceUriOf(withMeta({ ui: { resourceUri: VIEW }, 'ui/resourceUri': 'ui://other' }))).toBe(VIEW);
    expect(uiResourceUriOf(withMeta({ 'ui/resourceUri': VIEW }))).toBe(VIEW);
    // A present but unusable ui.resourceUri is no view (the flat key doesn't rescue it).
    expect(uiResourceUriOf(withMeta({ ui: { resourceUri: 7 }, 'ui/resourceUri': VIEW }))).toBeNull();
    expect(uiResourceUriOf(withMeta(undefined))).toBeNull();
  });

  test('uiMetaText: canonical, only the keys sent; "null" without; clipped with a hash', () => {
    expect(uiMetaText(withMeta({ ui: { visibility: ['app'], resourceUri: VIEW, prefersBorder: true }, other: 1 }))).toBe(
      `{"resourceUri":"${VIEW}","visibility":["app"]}`,
    );
    expect(uiMetaText(withMeta({ ui: { visibility: null } }))).toBe('{"visibility":null}');
    expect(uiMetaText(withMeta({ other: 1 }))).toBe('null');
    expect(uiMetaText(withMeta(undefined))).toBe('null');
    const long = uiMetaText(withMeta({ ui: { resourceUri: 'x'.repeat(5000) } }));
    expect(long).toContain('…#sha256:');
    expect(long).not.toBe(uiMetaText(withMeta({ ui: { resourceUri: `${'x'.repeat(4999)}y` } })));
  });

  test('appOnlyFromUiMeta mirrors isAppOnly and fails closed', () => {
    expect(appOnlyFromUiMeta(null)).toBe(false);
    expect(appOnlyFromUiMeta('null')).toBe(false);
    expect(appOnlyFromUiMeta(`{"resourceUri":"${VIEW}"}`)).toBe(false);
    expect(appOnlyFromUiMeta('{"visibility":["model","app"]}')).toBe(false);
    expect(appOnlyFromUiMeta('{"visibility":["app"]}')).toBe(true);
    expect(appOnlyFromUiMeta('{"visibility":[]}')).toBe(true);
    expect(appOnlyFromUiMeta('{"visibility":null}')).toBe(true);
    expect(appOnlyFromUiMeta('{"visibility":"model"}')).toBe(true);
    expect(appOnlyFromUiMeta('{"x…#sha256:00')).toBe(true);
    expect(appOnlyFromUiMeta('nope')).toBe(true);
  });
});

describe('page validation (TC-244, TC-249)', () => {
  const item = (o: Record<string, unknown> = {}) => ({ uri: VIEW, mimeType: UI_MIME, text: '<p>hi</p>', ...o });

  test('a page: exactly the served fields', () => {
    const out = validatePage({ contents: [item({ _meta: { ui: { prefersBorder: true } }, extra: 'dropped' })] }, VIEW);
    expect(out).toEqual([{ uri: VIEW, mimeType: UI_MIME, text: '<p>hi</p>', _meta: { ui: { prefersBorder: true } } }]);
    expect(validatePage({ contents: [{ uri: VIEW, mimeType: UI_MIME, blob: 'PGh0bWw+' }] }, VIEW)).toEqual([{ uri: VIEW, mimeType: UI_MIME, blob: 'PGh0bWw+' }]);
  });

  test.each([
    ['no contents', {}],
    ['empty contents', { contents: [] }],
    ['wrong mimeType', { contents: [item({ mimeType: 'text/html' })] }],
    ['mimeType with a space', { contents: [item({ mimeType: 'text/html; profile=mcp-app' })] }],
    ['another uri', { contents: [item({ uri: 'ui://fake/other.html' })] }],
    ['a second item with another uri', { contents: [item(), item({ uri: `${VIEW}#x` })] }],
    ['text and blob', { contents: [item({ blob: 'x' })] }],
    ['neither text nor blob', { contents: [{ uri: VIEW, mimeType: UI_MIME }] }],
    ['text not a string', { contents: [item({ text: 1 })] }],
    ['_meta not an object', { contents: [item({ _meta: 'x' })] }],
    ['not an object', null],
  ])('refused: %s', (_, result) => {
    expect(validatePage(result, VIEW)).toBeNull();
  });

  test('over the size limit: refused', () => {
    expect(validatePage({ contents: [item({ text: 'x'.repeat(1000) })] }, VIEW, 500)).toBeNull();
    expect(validatePage({ contents: [item({ text: 'x'.repeat(100) })] }, VIEW, 500)).not.toBeNull();
  });
});

describe('page hash and CSP (TC-248)', () => {
  const page = (text: string, _meta?: Record<string, unknown>) => [{ uri: VIEW, mimeType: UI_MIME, text, ...(_meta ? { _meta } : {}) }];

  test('stable, and changed by the text or the _meta (a widened CSP)', () => {
    const csp = { ui: { csp: { connectDomains: ['https://a.example'] } } };
    expect(pageHash(page('<p>1</p>', csp))).toBe(pageHash(page('<p>1</p>', { ui: { csp: { connectDomains: ['https://a.example'] } } })));
    expect(pageHash(page('<p>1</p>', csp))).not.toBe(pageHash(page('<p>2</p>', csp)));
    expect(pageHash(page('<p>1</p>', csp))).not.toBe(pageHash(page('<p>1</p>', { ui: { csp: { connectDomains: ['https://a.example', 'https://b.example'] } } })));
    expect(pageHash(page('<p>1</p>'))).toMatch(/^[0-9a-f]{64}$/);
    // The uri as requested is not part of it.
    expect(pageHash([{ uri: 'ui://x/y', mimeType: UI_MIME, text: '<p>1</p>' }])).toBe(pageHash(page('<p>1</p>')));
  });

  test('pageCsp: merged, clipped, strings only; null without csp/permissions', () => {
    expect(pageCsp(page('x'))).toBeNull();
    expect(pageCsp(page('x', { ui: { prefersBorder: true } }))).toBeNull();
    const c = pageCsp([
      ...page('x', { ui: { csp: { connectDomains: ['https://a.example', 7, 'https://a.example'], resourceDomains: ['https://cdn.example'] }, permissions: { camera: {} } } }),
    ])!;
    expect(c).toEqual({ connectDomains: ['https://a.example'], resourceDomains: ['https://cdn.example'], frameDomains: [], baseUriDomains: [], permissions: ['camera'] });
    expect(parseCsp(JSON.stringify(c))).toEqual(c);
    expect(parseCsp('nope')).toBeNull();
    const many = pageCsp(page('x', { ui: { csp: { connectDomains: Array.from({ length: 50 }, (_, i) => `https://${i}.example/${'p'.repeat(300)}`) } } }))!;
    expect(many.connectDomains).toHaveLength(20);
    expect(many.connectDomains[0]!.length).toBe(200);
    // An empty list is "said": no external connections.
    expect(pageCsp(page('x', { ui: { csp: { connectDomains: [] } } }))).toEqual({ connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [], permissions: [] });
  });
});

describe('shown (TC-246, TC-247)', () => {
  const ack = { contentHash: 'h1', acknowledgedHash: 'h1' };
  const row = (o: Partial<ViewRow> = {}): ViewRow => ({ name: 'show', uiResourceUri: VIEW, uiEnabled: true, appOnly: false, denied: false, vanished: false, ...o });

  test('viewShown needs every condition', () => {
    expect(viewShown(row(), ack)).toBe(true);
    expect(viewShown(row({ uiResourceUri: null }), ack)).toBe(false);
    expect(viewShown(row({ uiEnabled: false }), ack)).toBe(false);
    expect(viewShown(row({ denied: true }), ack)).toBe(false);
    expect(viewShown(row({ vanished: true }), ack)).toBe(false);
    expect(viewShown(row(), null)).toBe(false);
    expect(viewShown(row(), { contentHash: null, acknowledgedHash: null })).toBe(false);
    expect(viewShown(row(), { contentHash: 'h1', acknowledgedHash: null })).toBe(false);
    expect(viewShown(row(), { contentHash: 'h2', acknowledgedHash: 'h1' })).toBe(false);
    expect(viewShown(row(), { contentHash: '', acknowledgedHash: '' })).toBe(false);
  });

  test('view-only tools only with an anchor (a shown model-visible tool)', () => {
    const pages = new Map([[VIEW, ack]]);
    const app = row({ name: 'refresh', appOnly: true });
    expect(shownViews([app], pages)).toEqual({ shown: new Set(), anchor: false, uris: new Map() });
    const both = shownViews([row(), app], pages);
    expect(both.anchor).toBe(true);
    expect([...both.shown]).toEqual(['show', 'refresh']);
    expect(both.uris).toEqual(new Map([[VIEW, ['show', 'refresh']]]));
    expect(shownViews([row({ denied: true }), app], pages).anchor).toBe(false);
    expect(shownViews([row({ uiEnabled: false }), app], pages).anchor).toBe(false);
  });

  test('uiState', () => {
    expect(uiState(false, undefined)).toBe('new');
    expect(uiState(false, { contentHash: null, acknowledgedHash: null, lastReadFailed: true })).toBe('unreadable');
    expect(uiState(true, { contentHash: 'h', acknowledgedHash: null })).toBe('new');
    expect(uiState(true, { contentHash: 'h2', acknowledgedHash: 'h1' })).toBe('changed');
    expect(uiState(false, { contentHash: 'h2', acknowledgedHash: 'h1' })).toBe('changed');
    expect(uiState(true, ack)).toBe('shown');
    expect(uiState(false, ack)).toBe('off');
    // A failed re-read of a page that was read keeps its state.
    expect(uiState(true, { ...ack, lastReadFailed: true })).toBe('shown');
  });
});

describe('/mcp URIs (TC-246, TC-247)', () => {
  test('rewrite and reverse', () => {
    expect(unifiedUiUri('grafana', VIEW)).toBe('ui://grafana/fake/chart.html');
    expect(splitUnifiedUiUri('ui://grafana/fake/chart.html')).toEqual({ slug: 'grafana', uri: VIEW });
  });

  test.each([['ui://'], ['ui://grafana'], ['ui://grafana/'], ['http://grafana/x'], ['ui://gra_fana/x'], ['ui://Grafana/x'], ['ui://register/x'], ['ui:///x'], [42]])(
    'bad form %s: null',
    (uri) => {
      expect(splitUnifiedUiUri(uri)).toBeNull();
    },
  );

  test('withUnifiedUiUri rewrites ui.resourceUri and the flat key, nothing else', () => {
    const t = withMeta({ ui: { resourceUri: VIEW, visibility: ['model'] }, 'ui/resourceUri': VIEW, keep: 1 });
    expect((withUnifiedUiUri(t, 'g') as never as { _meta: unknown })._meta).toEqual({
      ui: { resourceUri: 'ui://g/fake/chart.html', visibility: ['model'] },
      'ui/resourceUri': 'ui://g/fake/chart.html',
      keep: 1,
    });
    const flatBad = withMeta({ ui: { resourceUri: VIEW }, 'ui/resourceUri': 'https://x' });
    expect((withUnifiedUiUri(flatBad, 'g') as never as { _meta: Record<string, unknown> })._meta['ui/resourceUri']).toBeUndefined();
  });
});
