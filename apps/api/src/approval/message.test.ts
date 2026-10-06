// TC-32 (unit): the approval push payload is small and carries only what the
// notification needs.
import { describe, expect, test } from 'vitest';
import { approvalMessage, approvalUpdateMessage } from './message.js';
import { MAX_PAYLOAD_BYTES, payloadBytes, sendToSubscriptions, type PushMessage } from '../lib/push.js';

describe('approval push payload (TC-32)', () => {
  test('fields, and under 4 KB even with huge agent-controlled input', () => {
    const msg = approvalMessage({
      id: 'abcdefghijklmnopqrstuv',
      upstreamName: 'U'.repeat(5000),
      toolName: 't'.repeat(5000),
      args: { item: 'ü'.repeat(100_000), other: 'x' },
      deadline: new Date('2026-10-04T12:05:00Z'),
    });
    expect(Object.keys(msg).sort()).toEqual(['expiresAt', 'id', 'summary', 'tool', 'type', 'upstream']);
    expect(msg).toMatchObject({ type: 'approval', id: 'abcdefghijklmnopqrstuv', expiresAt: '2026-10-04T12:05:00.000Z' });
    expect(payloadBytes(msg)).toBeLessThan(1024);
  });

  test('the sender refuses an oversized payload instead of sending it', async () => {
    const sent: unknown[] = [];
    const big: PushMessage = { type: 'test', title: 'x', body: 'y'.repeat(MAX_PAYLOAD_BYTES) };
    const failures = await sendToSubscriptions([{ id: 1, endpoint: 'https://e', p256dh: 'p', auth: 'a' }], big, { ttl: 10, urgency: 'high' }, {
      transport: async (_s, p) => void sent.push(p),
      onGone: async () => {},
      onSuccess: async () => {},
      log: () => {},
    });
    expect(sent).toEqual([]);
    expect(failures).toHaveLength(1);
  });

  test('404/410 removes the subscription; other errors keep it; TTL and urgency are passed', async () => {
    const gone: number[] = [];
    const opts: unknown[] = [];
    const subs = [1, 2, 3].map((id) => ({ id, endpoint: `https://e/${id}`, p256dh: 'p', auth: 'a' }));
    const failures = await sendToSubscriptions(subs, { type: 'resolved', id: 'x', outcome: 'expired' }, { ttl: 42.7, urgency: 'high' }, {
      transport: async (s, _p, o) => {
        opts.push(o);
        if (s.id === 1) throw Object.assign(new Error('gone'), { statusCode: 410 });
        if (s.id === 2) throw Object.assign(new Error('boom'), { statusCode: 500 });
      },
      onGone: async (s) => void gone.push(s.id),
      onSuccess: async () => {},
      log: () => {},
    });
    expect(gone).toEqual([1]);
    expect(failures.map((f) => f.subId)).toEqual([1, 2]);
    expect(opts[2]).toEqual({ ttl: 42, urgency: 'high' });
  });
});

describe('replacement push with the intent (TC-112)', () => {
  const base = { id: 'abcdefghijklmnopqrstuv', upstreamName: 'Haushalt', toolName: 'delete_all', args: {}, deadline: new Date('2026-10-04T12:05:00Z') };
  test('same id, update:true, intent <= 200 chars, shown risk', () => {
    const msg = approvalUpdateMessage({ ...base, intent: { status: 'DONE', title: 'T'.repeat(100), summary: 'L'.repeat(1000), risk: 'destructive', lowered: true } })!;
    expect(msg).toMatchObject({ type: 'approval', id: base.id, update: true, risk: 'destructive' });
    expect(msg.intent!.length).toBe(200);
    // TC-126: the title rides along, capped.
    expect(msg.intentTitle!.length).toBe(60);
    expect(payloadBytes(msg)).toBeLessThan(2048);
  });
  test('nothing without a summary', () => {
    expect(approvalUpdateMessage({ ...base, intent: { status: 'FAILED', title: null, summary: null, risk: null, lowered: null } })).toBeNull();
    // A summary without a title: no intentTitle field.
    expect(approvalUpdateMessage({ ...base, intent: { status: 'DONE', title: null, summary: 'x', risk: 'write', lowered: false } })).not.toHaveProperty('intentTitle');
    expect(approvalUpdateMessage(base)).toBeNull();
  });
});
