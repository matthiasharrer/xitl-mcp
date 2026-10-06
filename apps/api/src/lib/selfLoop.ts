// xitl as its own upstream (2026-10-06, Matthias proxied `rezepte-arbeit`
// through xitl's own `/mcp/rezepte` by accident). Two halves:
//
// - Save time (UX): an upstream URL on xitl's own external origin is refused
//   with a German message (routes/upstreams.ts).
// - Request time (enforcement): every request xitl sends to an upstream
//   (MCP and OAuth) carries INSTANCE_HEADER with this process's random id;
//   `/mcp`, `/mcp/*` and `/oauth/*` refuse a request carrying our own id. That
//   catches every alias the save-time check can't see (cluster service name,
//   IP, a second hostname) and stops a slug pointing at itself from recursing.
//   Per process is enough: the loop runs within the one replica.
//
// The id is not a secret: a forged header can only make xitl refuse a request.
import crypto from 'node:crypto';

export const INSTANCE_HEADER = 'X-Xitl-Instance';

const instanceId = crypto.randomBytes(16).toString('hex');

/** This process's id, sent on every upstream request. */
export function ownInstanceId(): string {
  return instanceId;
}

/** True when an incoming request was sent by this very process. */
export function isOwnRequest(headerValue: string | undefined): boolean {
  return headerValue !== undefined && headerValue.trim() === instanceId;
}

/** The 400 for an upstream URL on xitl's own address. */
export const OWN_ADDRESS = {
  error: 'Das ist die Adresse von xitl selbst. Trag die Adresse des eigentlichen MCP-Servers ein.',
  code: 'own_address',
} as const;

/** True when `url` is on `ownOrigin` (scheme + host + port; host case and
 * default ports normalized by URL). Unparsable input -> false (the URL
 * schema rejects it anyway). Pure. */
export function isOwnOrigin(url: string, ownOrigin: string): boolean {
  try {
    return new URL(url).origin === new URL(ownOrigin).origin;
  } catch {
    return false;
  }
}
