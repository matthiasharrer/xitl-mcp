// ADR-0029: answer validation (TC-140 garbage), verdict/threshold (TC-139),
// env (TC-142 off = no check), the Clef request.
import { describe, expect, it, vi } from 'vitest';
import { clefCheck, clefEndpoint, InvalidAnswer, parseAnswer, pauseCheckFromEnv, thresholdFromEnv, timeoutFromEnv, verdict } from './check.js';

const ok = (probabilities: Record<string, unknown>, choice: unknown = 'gleich') => ({ answers: { richtung: { type: 'choice', choice, probabilities, confidence: 0.5 } } });

describe('parseAnswer (strict, TC-140)', () => {
  it('accepts the real shape', () => {
    expect(parseAnswer(ok({ gleich: 0.9, richtungswechsel: 0.05, ausweitung: 0.05 }))).toEqual({
      choice: 'gleich',
      probabilities: { gleich: 0.9, richtungswechsel: 0.05, ausweitung: 0.05 },
    });
  });

  it.each([
    ['no answers', {}],
    ['null', null],
    ['no richtung', { answers: { other: {} } }],
    ['choice not an option', ok({ gleich: 0.9 }, 'ja')],
    ['choice missing', { answers: { richtung: { probabilities: { gleich: 0.9 } } } }],
    ['gleich missing', ok({ richtungswechsel: 0.9, ausweitung: 0.1 })],
    ['probability > 1', ok({ gleich: 1.5 })],
    ['negative', ok({ gleich: 0.9, ausweitung: -0.1 })],
    ['NaN as string', ok({ gleich: 'NaN' })],
    ['Infinity', ok({ gleich: Infinity })],
    ['NaN', ok({ gleich: NaN })],
    ['unknown key', ok({ gleich: 0.9, passt: 0.1 })],
    ['probabilities an array', ok([0.9] as unknown as Record<string, unknown>)],
  ])('rejects %s', (_, body) => {
    expect(() => parseAnswer(body)).toThrow(InvalidAnswer);
  });
});

describe('verdict (TC-139)', () => {
  const a = (gleich: number, w = (1 - gleich) / 2, x = (1 - gleich) / 2) => ({ choice: 'gleich' as const, probabilities: { gleich, richtungswechsel: w, ausweitung: x } });
  it('p(gleich) ≥ threshold matches; just below is a mismatch', () => {
    expect(verdict(a(0.8), 0.8)).toEqual({ kind: 'match', score: 0.8 });
    expect(verdict(a(0.7999), 0.8).kind).toBe('mismatch');
    expect(verdict(a(0.85), 0.9).kind).toBe('mismatch');
    expect(verdict(a(0.9), 0.9).kind).toBe('match');
  });
  it('labels the stronger deviation (tie: Richtungswechsel)', () => {
    expect(verdict(a(0.1, 0.2, 0.7), 0.8)).toEqual({ kind: 'mismatch', score: 0.1, deviation: 'ausweitung' });
    expect(verdict(a(0.1, 0.7, 0.2), 0.8)).toMatchObject({ deviation: 'richtungswechsel' });
    expect(verdict(a(0.5, 0.25, 0.25), 0.8)).toMatchObject({ deviation: 'richtungswechsel' });
  });
  it('an unusable threshold is the default 0.8, never "everything passes"', () => {
    for (const t of [NaN, 0, -1, 2, Infinity]) {
      expect(verdict(a(0.79), t).kind).toBe('mismatch');
      expect(verdict(a(0.8), t).kind).toBe('match');
    }
  });
});

describe('env', () => {
  it('PAUSE_CHECK_THRESHOLD: (0,1] or the default, logged', () => {
    const warn = vi.fn();
    expect(thresholdFromEnv(undefined, warn)).toBe(0.8);
    expect(thresholdFromEnv('0.9', warn)).toBe(0.9);
    expect(warn).not.toHaveBeenCalled();
    for (const bad of ['abc', '2', '-1', '0', 'NaN']) expect(thresholdFromEnv(bad, warn)).toBe(0.8);
    expect(warn).toHaveBeenCalledTimes(5);
  });
  it('PAUSE_CHECK_TIMEOUT_MS: 1 … 60 000 or 10 000', () => {
    expect(timeoutFromEnv(undefined)).toBe(10_000);
    expect(timeoutFromEnv('1500')).toBe(1500);
    for (const bad of ['0', '-5', 'x', '1.5', '600000', '']) expect(timeoutFromEnv(bad)).toBe(10_000);
  });
  it('TC-142: no PAUSE_CHECK_URL = off (null); credentials or a non-http URL = off', () => {
    expect(pauseCheckFromEnv({})).toBeNull();
    expect(pauseCheckFromEnv({ PAUSE_CHECK_URL: '  ' })).toBeNull();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(pauseCheckFromEnv({ PAUSE_CHECK_URL: 'http://u:p@clef:8080' })).toBeNull();
    expect(pauseCheckFromEnv({ PAUSE_CHECK_URL: 'file:///etc/passwd' })).toBeNull();
    err.mockRestore();
  });
  it('the endpoint: /v1/systemone appended once; only its host:port allowed', () => {
    expect(clefEndpoint('http://clef.ai.svc:8080').endpoint.href).toBe('http://clef.ai.svc:8080/v1/systemone');
    expect(clefEndpoint('http://clef.ai.svc:8080/v1/systemone').endpoint.href).toBe('http://clef.ai.svc:8080/v1/systemone');
    expect(clefEndpoint('http://clef/').allowance).toEqual([{ host: 'clef', port: 80 }]);
  });
});

describe('clefCheck', () => {
  const respond = (status: number, body: string) => vi.fn(async () => new Response(body, { status, headers: { 'Content-Type': 'application/json' } }));

  it('POSTs the systemone body through outboundFetch with the host allowance; no model unless set', async () => {
    const f = respond(200, JSON.stringify(ok({ gleich: 0.95, richtungswechsel: 0.03, ausweitung: 0.02 })));
    const answer = await clefCheck({ url: 'http://clef:8080', fetch: f as never }).check('STATE', new AbortController().signal);
    expect(answer.probabilities.gleich).toBe(0.95);
    const [url, init, opts] = f.mock.calls[0] as unknown as [URL, RequestInit, { alsoAllow: unknown }];
    expect(url.href).toBe('http://clef:8080/v1/systemone');
    const body = JSON.parse(String(init.body));
    expect(body.state).toBe('STATE');
    expect(body).not.toHaveProperty('model');
    expect(body.questions.richtung.type).toBe('choice');
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(opts.alsoAllow).toEqual([{ host: 'clef', port: 8080 }]);

    const g = respond(200, JSON.stringify(ok({ gleich: 0.95 })));
    await clefCheck({ url: 'http://clef:8080', model: 'clef', fetch: g as never }).check('S', new AbortController().signal);
    expect(JSON.parse(String((g.mock.calls[0] as unknown as [URL, RequestInit])[1].body)).model).toBe('clef');
  });

  it('rejects on HTTP errors and garbage', async () => {
    const sig = new AbortController().signal;
    await expect(clefCheck({ url: 'http://clef', fetch: respond(500, '{}') as never }).check('S', sig)).rejects.toThrow();
    await expect(clefCheck({ url: 'http://clef', fetch: respond(200, 'kein JSON') as never }).check('S', sig)).rejects.toThrow(InvalidAnswer);
    await expect(clefCheck({ url: 'http://clef', fetch: respond(200, '{"answers":{}}') as never }).check('S', sig)).rejects.toThrow(InvalidAnswer);
  });
});
