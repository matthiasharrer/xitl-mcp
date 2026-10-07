// Fake Clef (llama.cpp `/v1/systemone`) for the AI check of allow pauses
// (ADR-0029, TC-137…148). Started by Playwright as a webServer on :3212; the
// e2e server's PAUSE_CHECK_URL points here, so the REAL client in
// apps/api/src/pausecheck/check.ts (request, validation, timeout) is what runs.
//
// Deterministic verdict, driven ONLY by the NEW call's arguments (the last
// `<call>` block of the state): `__check`:
//   absent / "gleich:<p>"   p(gleich)=p (default 0.95), the rest split evenly
//   "wechsel:<p>"           p(richtungswechsel)=p, the rest split evenly
//   "ausweitung:<p>"        p(ausweitung)=p, the rest split evenly
//   "error"                 HTTP 500
//   "hang"                  answers only after 5 s (beyond the timeout)
//   "garbage:<kind>"        nojson | norichtung | nan | gt1 | badchoice | nogleich
// The marker exists only here; production code never reads it.
//
//   GET /control/log   every request so far: { body, blocks } (blocks = the
//                      parsed `<call>` JSON lines of the state, in order)
//   GET /health
import http from 'node:http';
import { FAKE_CLEF_PORT } from './paths.js';

const log: { body: any; blocks: Record<string, unknown>[] }[] = [];

function blocksOf(state: string): Record<string, unknown>[] {
  const lines = state.split('\n');
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i + 2 < lines.length; i++) {
    if (lines[i] === '<call>' && lines[i + 2] === '</call>') {
      try {
        out.push(JSON.parse(lines[i + 1]!));
      } catch {
        /* not a block */
      }
    }
  }
  return out;
}

const send = (res: http.ServerResponse, status: number, text: string) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(text);
};

function answer(winner: 'gleich' | 'richtungswechsel' | 'ausweitung', p: number) {
  const rest = (1 - p) / 2;
  const probabilities = { gleich: rest, richtungswechsel: rest, ausweitung: rest, [winner]: p };
  const choice = (Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0]) as string;
  return { model: 'fake-clef', answers: { richtung: { type: 'choice', choice, probabilities, confidence: p } }, usage: { input_tokens: 1, output_tokens: 0 } };
}

const GARBAGE: Record<string, string> = {
  nojson: 'Das ist kein JSON.',
  norichtung: JSON.stringify({ answers: { passt: { noul: 0.9 } } }),
  nan: '{"answers":{"richtung":{"type":"choice","choice":"gleich","probabilities":{"gleich":NaN,"richtungswechsel":0,"ausweitung":0}}}}',
  gt1: JSON.stringify({ answers: { richtung: { type: 'choice', choice: 'gleich', probabilities: { gleich: 1.7, richtungswechsel: 0, ausweitung: 0 } } } }),
  badchoice: JSON.stringify({ answers: { richtung: { type: 'choice', choice: 'ja', probabilities: { gleich: 0.99, richtungswechsel: 0, ausweitung: 0.01 } } } }),
  nogleich: JSON.stringify({ answers: { richtung: { type: 'choice', choice: 'richtungswechsel', probabilities: { richtungswechsel: 0.5, ausweitung: 0.5 } } } }),
};

http
  .createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/health') return send(res, 200, '{"status":"ok"}');
    if (path === '/control/log') return send(res, 200, JSON.stringify(log));
    if (path !== '/v1/systemone' || req.method !== 'POST') return send(res, 404, '{"error":"not found"}');
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: any;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return send(res, 400, '{"error":"bad json"}');
    }
    const blocks = typeof body?.state === 'string' ? blocksOf(body.state) : [];
    log.push({ body, blocks });
    const args = blocks[blocks.length - 1]?.arguments as Record<string, unknown> | undefined;
    const mode = typeof args?.__check === 'string' ? args.__check : 'gleich:0.95';
    if (mode === 'error') return send(res, 500, '{"error":"boom"}');
    if (mode === 'hang') {
      await new Promise((r) => setTimeout(r, 5000));
      return send(res, 200, JSON.stringify(answer('gleich', 0.99)));
    }
    if (mode.startsWith('garbage:')) return send(res, 200, GARBAGE[mode.slice(8)] ?? 'garbage');
    const [kind, raw] = mode.split(':');
    const p = Number(raw);
    const winner = kind === 'wechsel' ? 'richtungswechsel' : kind === 'ausweitung' ? 'ausweitung' : 'gleich';
    return send(res, 200, JSON.stringify(answer(winner, Number.isFinite(p) ? p : 0.95)));
  })
  .listen(FAKE_CLEF_PORT, '127.0.0.1', () => console.log(`fake clef on http://127.0.0.1:${FAKE_CLEF_PORT}`));
