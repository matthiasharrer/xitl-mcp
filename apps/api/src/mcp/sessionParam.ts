// ADR-0040: the `xitl_session` tool parameter of an upstream with
// `sessionParam`. Added to every listed tool (after sync and hashing, so the
// stored definition is the upstream's own) and taken out of every call's
// arguments before policy, audit and forwarding: nothing downstream of the
// call's entry sees it, and an upstream property of the same name is never
// forwarded.
import type { Tool } from '@modelcontextprotocol/client';
import type { Upstream } from '../generated/prisma/client.js';
import { isHandleShaped } from '../upstream/connection.js';

export const SESSION_PARAM = 'xitl_session';

const DESCRIPTION =
  'Sitzungs-ID aus einer früheren xitl-Antwort, damit der Aufruf im selben Zustand (z. B. Browser) läuft; weglassen startet eine neue Sitzung. / ' +
  'Session id from an earlier xitl answer, to run in the same state (e.g. browser); omit it to start a new session.';

/** Does this upstream use session handles? Never the in-process upstream. */
export function usesSessions(row: Pick<Upstream, 'sessionParam' | 'auth'>): boolean {
  return row.sessionParam && row.auth !== 'BUILTIN';
}

/** The tool with `xitl_session` as an optional string property (replacing
 * an upstream property of that name, and never required). */
export function withSessionParam(tool: Tool): Tool {
  const schema = (tool.inputSchema ?? { type: 'object' }) as Tool['inputSchema'] & { required?: unknown };
  const properties = { ...(schema.properties ?? {}), [SESSION_PARAM]: { type: 'string', description: DESCRIPTION } };
  const required = Array.isArray(schema.required) ? schema.required.filter((r) => r !== SESSION_PARAM) : undefined;
  return { ...tool, inputSchema: { ...schema, type: 'object', properties, ...(required ? { required } : {}) } };
}

/** Splits a call's arguments: the rest (what policy, audit and the upstream
 * see) and the handle asked for, if it is handle-shaped. `given` says whether
 * the call passed the parameter at all (an unusable value counts as given:
 * it gets the "unknown session" answer, never a lookup). */
export function splitSessionArg(args: Record<string, unknown>): { rest: Record<string, unknown>; handle: string | null; given: boolean } {
  if (!Object.prototype.hasOwnProperty.call(args, SESSION_PARAM)) return { rest: args, handle: null, given: false };
  const { [SESSION_PARAM]: value, ...rest } = args;
  const given = value !== undefined && value !== null && value !== '';
  return { rest, handle: isHandleShaped(value) ? value : null, given };
}
