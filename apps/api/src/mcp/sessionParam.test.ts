// ADR-0040 (TC-265, unit): the `xitl_session` parameter is added to listed
// tools and taken out of call arguments.
import { describe, expect, test } from 'vitest';
import { SESSION_PARAM, splitSessionArg, usesSessions, withSessionParam } from './sessionParam.js';

const H = 'AAAAAAAAAAAAAAAAAAAAAA';

describe('withSessionParam', () => {
  test('adds an optional string property, keeps the rest', () => {
    const t = withSessionParam({ name: 'nav', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } });
    expect(Object.keys(t.inputSchema.properties ?? {})).toEqual(['url', SESSION_PARAM]);
    expect((t.inputSchema.properties as Record<string, { type: string }>)[SESSION_PARAM]!.type).toBe('string');
    expect(t.inputSchema.required).toEqual(['url']);
  });
  test('a tool without properties gets an object schema', () => {
    const t = withSessionParam({ name: 'x', inputSchema: { type: 'object' } });
    expect(Object.keys(t.inputSchema.properties ?? {})).toEqual([SESSION_PARAM]);
  });
  test('an upstream property of the same name is replaced and never required', () => {
    const t = withSessionParam({ name: 'x', inputSchema: { type: 'object', properties: { [SESSION_PARAM]: { type: 'number' } }, required: [SESSION_PARAM, 'a'] } });
    expect((t.inputSchema.properties as Record<string, { type: string }>)[SESSION_PARAM]!.type).toBe('string');
    expect(t.inputSchema.required).toEqual(['a']);
  });
});

describe('splitSessionArg', () => {
  test('absent: nothing given, args unchanged', () => {
    const args = { url: 'u' };
    expect(splitSessionArg(args)).toEqual({ rest: args, handle: null, given: false });
  });
  test('a handle: taken out, returned', () => {
    expect(splitSessionArg({ url: 'u', [SESSION_PARAM]: H })).toEqual({ rest: { url: 'u' }, handle: H, given: true });
  });
  test('anything not handle-shaped is taken out too, never looked up', () => {
    for (const v of ['nope', 42, { a: 1 }, `${H}x`]) expect(splitSessionArg({ [SESSION_PARAM]: v })).toEqual({ rest: {}, handle: null, given: true });
    expect(splitSessionArg({ [SESSION_PARAM]: '' })).toEqual({ rest: {}, handle: null, given: false });
  });
});

test('usesSessions: never for the built-in upstream', () => {
  expect(usesSessions({ sessionParam: true, auth: 'HEADER' })).toBe(true);
  expect(usesSessions({ sessionParam: true, auth: 'BUILTIN' })).toBe(false);
  expect(usesSessions({ sessionParam: false, auth: 'NONE' })).toBe(false);
});
