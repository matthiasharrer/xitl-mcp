export type Me = { id: number; username: string; displayName: string };

export type Policy = 'ALLOW' | 'ASK' | 'DENY';
export type UpstreamAuth = 'OAUTH' | 'HEADER' | 'NONE';
export type UpstreamStatus = 'NOT_CONNECTED' | 'CONNECTED' | 'NEEDS_RECONNECT';

export interface Upstream {
  id: number;
  slug: string;
  name: string;
  url: string;
  description: string | null;
  defaultPolicy: Policy;
  auth: UpstreamAuth;
  status: UpstreamStatus;
  headerName: string | null;
  hasHeaderValue: boolean;
  /** The user confirmed an internal address for this upstream (ADR-0020). */
  allowInternal: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UpstreamInput {
  name: string;
  slug: string;
  url: string;
  description: string | null;
  defaultPolicy: Policy;
  auth: UpstreamAuth;
  headerName?: string | null;
  /** Write-only; omitted on edit to keep the stored value. */
  headerValue?: string | null;
  /** "Trotzdem erlauben": confirm an internal URL (ADR-0020). */
  allowInternal?: boolean;
}

export type ToolHint = 'read' | 'write' | 'destructive';

export interface ToolRow {
  id: number;
  name: string;
  description: string | null;
  hint: ToolHint;
  /** The tool's own policy; null = "Standard" (upstream default). */
  policy: Policy | null;
  /** What applies without a client override. */
  effectivePolicy: Policy;
  path: string;
  isNew: boolean;
  /** Acknowledged once, then its description/annotations changed (TC-36). */
  isChanged: boolean;
  lastSeenAt: string;
  clientPolicies: { mcpClientId: number; policy: Policy }[];
}

export interface ToolsView {
  upstream: { id: number; name: string; defaultPolicy: Policy; status: UpstreamStatus; auth: UpstreamAuth };
  clients: { id: number; name: string }[];
  tools: ToolRow[];
}

export interface McpClient {
  id: number;
  name: string;
  /** OAUTH: registered via OAuth; TOKEN: a per-upstream access token (ADR-0015). */
  kind: 'OAUTH' | 'TOKEN';
  upstream: { id: number; slug: string; name: string } | null;
  /** TOKEN scope (ADR-0018): true = all upstreams (`upstream` is null). */
  allUpstreams: boolean;
  /** First characters of a TOKEN client's token, e.g. "xitl_abc1234". */
  tokenPrefix: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

/** The MCP session a call came in on (ADR-0016); null when sessionless. */
export type SessionRef = { id: string; createdAt: string } | null;

export interface SessionSummary {
  id: string;
  client: { id: number; name: string; kind: 'OAUTH' | 'TOKEN' };
  /** null: a session on the unified `/mcp` (all upstreams, ADR-0017). */
  upstream: { id: number; slug: string; name: string } | null;
  /** From the client's `initialize` (untrusted text). */
  clientInfo: { name: string | null; version: string | null };
  protocolVersion: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  endedAt: string | null;
  callCount: number;
}

export interface SessionDetail extends SessionSummary {
  /** Request header names seen in this session (names only). */
  headerNames: string[];
  /** `_meta` keys seen in tools/call (keys only). */
  metaKeys: string[];
  entries: AuditRow[];
}

export interface PendingApproval {
  id: string;
  state: 'pending';
  clientName: string;
  clientId: number;
  upstream: { id: number; slug: string; name: string };
  tool: string;
  arguments: unknown;
  rulePath: string;
  receivedAt: string;
  expiresAt: string;
  /** Time left when the server answered; the countdown runs from this. */
  remainingMs: number;
  /** false for new/changed tools: only "Erlauben" once, no snooze. */
  snoozable: boolean;
  /** Read-only by its stored annotations: offers "alle Lesetools". */
  readOnly: boolean;
  session: SessionRef;
}

export type Outcome = 'PENDING' | 'FORWARDED' | 'DENIED' | 'TIMED_OUT' | 'UPSTREAM_ERROR';

export interface ResolvedApproval {
  id: string;
  state: 'resolved';
  auditId: number;
  outcome: Outcome;
  decisionPath: string;
  clientName: string | null;
  upstream: { id: number; slug: string; name: string } | null;
  tool: string;
  arguments: unknown;
  receivedAt: string;
  decidedAt: string | null;
  session: SessionRef;
}

export type ApprovalDecision =
  | { decision: 'deny' }
  | { decision: 'approve'; snoozeMinutes?: number; snoozeUntilMidnight?: boolean; snoozeScope?: SnoozeScope };

/** What a snooze covers (TC-76). */
export type SnoozeScope = 'tool' | 'readonly' | 'upstream';

export interface AuditRow {
  id: number;
  tool: string;
  upstream: { id: number; slug: string; name: string } | null;
  clientName: string | null;
  /** McpClient row id; null once the client was revoked. */
  clientId: number | null;
  outcome: Outcome;
  decisionPath: string;
  isError: boolean | null;
  receivedAt: string;
  session: SessionRef;
}

export interface AuditDetail extends AuditRow {
  endpoint: string;
  policy: Policy;
  arguments: unknown;
  resultText: string | null;
  decidedAt: string | null;
  finishedAt: string | null;
  /** What this request said about its client (names only; ADR-0016). */
  diagnostics: {
    protocolVersion: string | null;
    clientInfo: string | null;
    userAgent: string | null;
    headerNames: string[];
    metaKeys: string[];
    traceId: string | null;
    cloudTraceId: string | null;
    anthropicClient: string | null;
  };
}

/** An API failure with a message that is safe to show to the user. */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** The API's machine-readable `code`, when it sends one (e.g. 'internal_address'). */
    public code: string | null = null,
  ) {
    super(message);
  }
}

function germanMessage(status: number): string {
  if (status === 0) return 'Keine Verbindung zum Server.';
  if (status === 404) return 'Das gibt es nicht mehr.';
  if (status === 409) return 'Das ist so nicht mehr möglich.';
  if (status === 400) return 'Die Eingabe ist ungültig.';
  if (status === 401) return 'Nicht angemeldet.';
  return 'Das hat nicht geklappt. Bitte versuche es noch einmal.';
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, germanMessage(0));
  }
  if (!res.ok) {
    // The API answers validation errors with a German `error` string.
    const b = await res.json().catch(() => null);
    const detail = typeof b?.error === 'string' ? (b.error as string) : null;
    const code = typeof b?.code === 'string' ? (b.code as string) : null;
    throw new ApiError(res.status, detail ?? germanMessage(res.status), code);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  me: () => request<Me>('GET', '/api/me'),
  listUpstreams: () => request<Upstream[]>('GET', '/api/upstreams'),
  createUpstream: (input: UpstreamInput) => request<Upstream>('POST', '/api/upstreams', input),
  updateUpstream: (id: number, patch: Partial<UpstreamInput>) =>
    request<Upstream>('PATCH', `/api/upstreams/${id}`, patch),
  deleteUpstream: (id: number) => request<void>('DELETE', `/api/upstreams/${id}`),
  listMcpClients: () => request<McpClient[]>('GET', '/api/mcp/clients'),
  renameMcpClient: (id: number, name: string) => request<McpClient>('PATCH', `/api/mcp/clients/${id}`, { name }),
  revokeMcpClient: (id: number) => request<void>('DELETE', `/api/mcp/clients/${id}`),
  /** The response is the only one that ever contains the token. */
  createUpstreamToken: (id: number, name: string) =>
    request<{ client: McpClient; token: string }>('POST', `/api/upstreams/${id}/tokens`, { name }),
  createAllUpstreamsToken: (name: string) => request<{ client: McpClient; token: string }>('POST', '/api/mcp/tokens', { name }),
  getHealth: () => request<{ status: string; version: string }>('GET', '/api/health'),
  getMcpConfig: () => request<{ configured: boolean }>('GET', '/api/mcp/config'),
  connectUpstream: (id: number) => request<{ authorizationUrl: string }>('POST', `/api/upstreams/${id}/connect`),
  getTools: (id: number) => request<ToolsView>('GET', `/api/upstreams/${id}/tools`),
  refreshTools: (id: number) => request<ToolsView>('POST', `/api/upstreams/${id}/tools/refresh`),
  setToolPolicy: (id: number, toolId: number, policy: Policy | null) =>
    request<ToolsView>('PATCH', `/api/upstreams/${id}/tools/${toolId}`, { policy }),
  acknowledgeTool: (id: number, toolId: number) =>
    request<ToolsView>('POST', `/api/upstreams/${id}/tools/${toolId}/acknowledge`),
  setClientPolicy: (id: number, toolId: number, clientId: number, policy: Policy) =>
    request<ToolsView>('PUT', `/api/upstreams/${id}/tools/${toolId}/clients/${clientId}`, { policy }),
  clearClientPolicy: (id: number, toolId: number, clientId: number) =>
    request<ToolsView>('DELETE', `/api/upstreams/${id}/tools/${toolId}/clients/${clientId}`),
  listApprovals: () => request<PendingApproval[]>('GET', '/api/approvals'),
  getApproval: (id: string) => request<PendingApproval | ResolvedApproval>('GET', `/api/approvals/${encodeURIComponent(id)}`),
  decideApproval: (id: string, d: ApprovalDecision) =>
    request<{ id: string; state: 'approved' | 'denied'; snoozeUntil: string | null }>('POST', `/api/approvals/${encodeURIComponent(id)}`, {
      ...d,
      via: 'page',
    }),
  listAudit: (before?: number) =>
    request<{ entries: AuditRow[]; nextBefore: number | null }>('GET', `/api/audit${before ? `?before=${before}` : ''}`),
  getAudit: (id: number) => request<AuditDetail>('GET', `/api/audit/${id}`),
  listSessions: (before?: string) =>
    request<{ sessions: SessionSummary[]; nextBefore: string | null }>(
      'GET',
      `/api/sessions${before ? `?before=${encodeURIComponent(before)}` : ''}`,
    ),
  getSession: (id: string) => request<SessionDetail>('GET', `/api/sessions/${encodeURIComponent(id)}`),
  getPushConfig: () => request<{ publicKey: string }>('GET', '/api/push/config'),
  savePushSubscription: (sub: { endpoint: string; keys: { p256dh: string; auth: string } }) =>
    request<unknown>('POST', '/api/push/subscriptions', sub),
  deletePushSubscription: (endpoint: string) => request<void>('DELETE', '/api/push/subscriptions', { endpoint }),
  sendPushTest: (endpoint: string) => request<void>('POST', '/api/push/test', { endpoint }),
};

export const messageOf = (e: unknown) =>
  e instanceof ApiError ? e.message : 'Das hat nicht geklappt. Bitte versuche es noch einmal.';

export const POLICY_LABEL: Record<Policy, string> = { ALLOW: 'Erlauben', ASK: 'Fragen', DENY: 'Verbieten' };

export const HINT_LABEL: Record<ToolHint, string> = { read: 'Lesen', write: 'Schreiben', destructive: 'Destruktiv' };

export const STATUS_LABEL: Record<UpstreamStatus, string> = {
  NOT_CONNECTED: 'Nicht verbunden',
  CONNECTED: 'Verbunden',
  NEEDS_RECONNECT: 'Neu verbinden nötig',
};

export const OUTCOME_LABEL: Record<Outcome, string> = {
  PENDING: 'Offen',
  FORWARDED: 'Weitergeleitet',
  DENIED: 'Abgelehnt',
  TIMED_OUT: 'Zeit abgelaufen',
  UPSTREAM_ERROR: 'Fehler',
};

const PATH_PART: Record<string, string> = {
  'policy:upstream-default': 'Standardregel',
  'policy:tool': 'Regel des Tools',
  'policy:client': 'Regel für diesen Client',
  'new-tool': 'neues Tool',
  'changed-tool': 'geändertes Tool',
  'unknown-tool': 'unbekanntes Tool',
  snooze: 'pausiert, ohne Nachfrage',
  'approved:page': 'erlaubt in der App',
  'approved:push': 'erlaubt per Benachrichtigung',
  'denied:page': 'abgelehnt in der App',
  'denied:push': 'abgelehnt per Benachrichtigung',
  timeout: 'Zeit abgelaufen',
  aborted: 'Verbindung abgebrochen',
  shutdown: 'Server neu gestartet',
  restart: 'Server neu gestartet',
  revoked: 'Client oder Upstream entfernt',
  flood: 'zu viele offene Freigaben',
  'ask:no-channel': 'Freigabe noch nicht verfügbar',
};

/** "policy:upstream-default+approved:page" -> "Standardregel → erlaubt in der App". */
export function decisionPathText(path: string): string {
  return path
    .split('+')
    .map((p) => PATH_PART[p] ?? p)
    .join(' → ');
}

const timeOnly = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });
const dayAndTime = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/** "Sitzung seit 14:02" (today) or "Sitzung seit 04.10., 14:02". */
export function sessionSinceText(createdAt: string, now = new Date()): string {
  const d = new Date(createdAt);
  return `Sitzung seit ${d.toDateString() === now.toDateString() ? timeOnly.format(d) : dayAndTime.format(d)}`;
}
