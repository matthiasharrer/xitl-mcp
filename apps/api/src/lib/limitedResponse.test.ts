// TC-48 (unit): upstream responses are bounded.
import { describe, expect, test } from 'vitest';
import { ResponseTooLarge, limitResponse } from './limitedResponse.js';

function streamOf(chunks: number[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const n of chunks) c.enqueue(new Uint8Array(n).fill(97));
      c.close();
    },
  });
}

describe('limitResponse (TC-48)', () => {
  test('a body within the limit passes unchanged, status and headers kept', async () => {
    const res = await limitResponse(new Response('{"a":1}', { status: 201, headers: { 'X-Y': 'z' } }), 100);
    expect(res.status).toBe(201);
    expect(res.headers.get('x-y')).toBe('z');
    expect(await res.json()).toEqual({ a: 1 });
  });

  test('a declared Content-Length over the limit is refused before reading', async () => {
    const res = new Response('x'.repeat(10), { headers: { 'Content-Length': '1000' } });
    await expect(limitResponse(res, 100)).rejects.toBeInstanceOf(ResponseTooLarge);
  });

  test('an undeclared (streamed) body errors once it passes the limit', async () => {
    const res = await limitResponse(new Response(streamOf([60, 60, 60])), 100);
    await expect(res.text()).rejects.toBeInstanceOf(ResponseTooLarge);
  });

  test('exactly the limit is fine; no body stays no body', async () => {
    expect((await (await limitResponse(new Response(streamOf([50, 50])), 100)).text()).length).toBe(100);
    const empty = await limitResponse(new Response(null, { status: 202 }), 100);
    expect(empty.status).toBe(202);
    expect(empty.body).toBeNull();
  });
});
