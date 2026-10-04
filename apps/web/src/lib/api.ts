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
  createdAt: string;
  lastUsedAt: string | null;
}

export interface PendingApproval {
  id: string;
  state: 'pending';
  clientName: string;
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
}

export type ApprovalDecision =
  | { decision: 'deny' }
  | { decision: 'approve'; snoozeMinutes?: number; snoozeUntilMidnight?: boolean };

export interface AuditRow {
  id: number;
  tool: string;
  upstream: { id: number; slug: string; name: string } | null;
  clientName: string | null;
  outcome: Outcome;
  decisionPath: string;
  isError: boolean | null;
  receivedAt: string;
}

export interface AuditDetail extends AuditRow {
  endpoint: string;
  policy: Policy;
  arguments: unknown;
  resultText: string | null;
  decidedAt: string | null;
  finishedAt: string | null;
}

/** An API failure with a message that is safe to show to the user. */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
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
    const detail = await res.json().then((b) => (typeof b?.error === 'string' ? b.error : null), () => null);
    throw new ApiError(res.status, detail ?? germanMessage(res.status));
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
  'new-tool': 'neues oder geändertes Tool',
  'unknown-tool': 'unbekanntes Tool',
  snooze: 'pausiert, ohne Nachfrage',
  'approved:page': 'erlaubt in der App',
  'approved:push': 'erlaubt per Benachrichtigung',
  'denied:page': 'abgelehnt in der App',
  'denied:push': 'abgelehnt per Benachrichtigung',
  timeout: 'Zeit abgelaufen',
  aborted: 'Verbindung abgebrochen',
  shutdown: 'Server neu gestartet',
  'ask:no-channel': 'Freigabe noch nicht verfügbar',
};

/** "policy:upstream-default+approved:page" -> "Standardregel → erlaubt in der App". */
export function decisionPathText(path: string): string {
  return path
    .split('+')
    .map((p) => PATH_PART[p] ?? p)
    .join(' → ');
}
