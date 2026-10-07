export type Me = {
  id: number;
  username: string;
  displayName: string;
  /** ADR-0029: "KI-Prüfung für Zeitfreigaben" (per user, default on). */
  pauseCheck: boolean;
  /** The server has the check configured (PAUSE_CHECK_URL); else no switch. */
  pauseCheckAvailable: boolean;
  /** ADR-0030: "Vorschlag" (the intent model) is configured. */
  autoDraftAvailable?: boolean;
};

/** ADR-0029: why the AI check sent a paused call back to the human. */
export interface PauseCheckView {
  result: 'mismatch' | 'error';
  choice: 'richtungswechsel' | 'ausweitung' | null;
  score: number | null;
}

/** ADR-0029: the user's AI check outage ("KI-Prüfung nicht erreichbar"). */
export interface PauseCheckOutage {
  failing: boolean;
  since: string | null;
}

const DEVIATION_LABEL: Record<string, string> = { richtungswechsel: 'Richtungswechsel', ausweitung: 'Ausweitung' };

/** Card / push text for a call the check sent back (same as the API's push note). */
export function pauseCheckNote(v: PauseCheckView): string {
  if (v.result === 'mismatch') {
    const label = v.choice ? DEVIATION_LABEL[v.choice] : null;
    return `KI-Prüfung: weicht ab${label ? ` (${label})` : ''} – Zeitfreigabe beendet`;
  }
  return 'KI-Prüfung nicht erreichbar';
}

/** ADR-0026 amendment: card/push text (same as the API's). */
export function sperreCheckNote(purpose: string): string {
  const p = purpose.length > 120 ? `${purpose.slice(0, 119)}…` : purpose;
  return `KI-Prüfung: fällt nicht unter die Sperre („${p}“) – bitte entscheiden`;
}

/** Verlauf detail line of a call checked against a Sperre's purpose. */
export function sperreLine(e: { decisionPath: string; sperreScore?: number | null }): string | null {
  if (typeof e.sperreScore !== 'number') return null;
  return e.decisionPath.split('+').includes('snooze-deny-ki-ask')
    ? `Sperre: KI sieht den Aufruf außerhalb (${score2(e.sperreScore)}) – gefragt`
    : `Sperre: KI sieht den Aufruf darunter (${score2(e.sperreScore)}) – abgelehnt`;
}

/** ADR-0030: why the AUTO check asked a call (same texts as the API's push note). */
export interface AutoCheckView {
  result: 'below' | 'error' | 'off' | 'norule';
  score: number | null;
}

export function autoCheckNote(v: AutoCheckView): string {
  switch (v.result) {
    case 'below':
      return `KI: von deiner Auto-Regel nicht eindeutig gedeckt${v.score !== null ? ` (${score2(v.score)})` : ''}`;
    case 'error':
      return 'KI-Prüfung nicht erreichbar – Auto-Regel fragt nach';
    case 'norule':
      return 'Auto: noch keine Auto-Regel für diesen Upstream – wird gefragt';
    default:
      return 'Auto: KI-Prüfung ausgeschaltet – wird gefragt';
  }
}

/** Verlauf detail line of an AUTO call: "Auto-Regel: gedeckt (0,95)",
 * "Auto-Regel: nicht eindeutig gedeckt (0,20)", "KI-Prüfung nicht erreichbar". */
export function autoLine(e: { decisionPath: string; autoScore?: number | null }): string | null {
  const parts = e.decisionPath.split('+');
  if (parts.includes('auto-error')) return 'KI-Prüfung nicht erreichbar';
  if (typeof e.autoScore !== 'number') return null;
  return parts.includes('auto') ? `Auto-Regel: gedeckt (${score2(e.autoScore)})` : `Auto-Regel: nicht eindeutig gedeckt (${score2(e.autoScore)})`;
}

function score2(n: number): string {
  return n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Verlauf detail line: "KI-Prüfung: passt (0,95)", "KI-Prüfung: weicht ab
 * (Richtungswechsel, 0,10) – Zeitfreigabe beendet", "KI-Prüfung nicht
 * erreichbar", or null when the call was not checked. */
export function pauseCheckLine(e: { decisionPath: string; pauseCheckScore: number | null; pauseCheckChoice: string | null }): string | null {
  if (e.decisionPath.split('+').includes('snooze-ki-error')) return 'KI-Prüfung nicht erreichbar';
  if (e.pauseCheckScore === null || e.pauseCheckChoice === null) return null;
  if (e.pauseCheckChoice === 'gleich') return `KI-Prüfung: passt (${score2(e.pauseCheckScore)})`;
  const label = DEVIATION_LABEL[e.pauseCheckChoice] ?? 'abweichend';
  return `KI-Prüfung: weicht ab (${label}, ${score2(e.pauseCheckScore)}) – Zeitfreigabe beendet`;
}

export type Policy = 'ALLOW' | 'ASK' | 'DENY' | 'AUTO';
export type UpstreamAuth = 'OAUTH' | 'HEADER' | 'NONE';
export type UpstreamStatus = 'NOT_CONNECTED' | 'CONNECTED' | 'NEEDS_RECONNECT';

export interface Upstream {
  id: number;
  slug: string;
  name: string;
  url: string;
  description: string | null;
  /** ADR-0022: the last contact failed (ISO); null when it worked / none yet. */
  lastFailureAt: string | null;
  defaultPolicy: Policy;
  auth: UpstreamAuth;
  status: UpstreamStatus;
  headerName: string | null;
  hasHeaderValue: boolean;
  /** The user confirmed an internal address for this upstream (ADR-0020). */
  allowInternal: boolean;
  /** ADR-0030: the prose rule for AUTO (own text), null = none. */
  autoRule: string | null;
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
  /** ADR-0030: the AUTO rule text (edit only); null/"" clears it. */
  autoRule?: string | null;
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
  /** ADR-0031: the advisory review hint of a new/changed tool. */
  review: ToolReview;
  parameters: ToolParam[] | null;
  annotations: Record<string, unknown> | null;
  /** The acknowledged definition before the change (or before a cosmetic edit). */
  previous: { description: string | null; annotations: Record<string, unknown> | null; parameters: ToolParam[] | null } | null;
  /** Last cosmetic-only change, auto-acknowledged (`auto-ack:cosmetic`). */
  cosmeticAckAt: string | null;
}

export interface ToolParam {
  name: string;
  /** canonical JSON of the schema's `type`, e.g. "\"string\"". */
  type: string | null;
  required: boolean;
  description: string | null;
}

/** ADR-0031: "Genauer ansehen" (attention + reasons) or "Unauffällig". */
export interface ToolReview {
  review: boolean;
  attention: boolean;
  reasons: string[];
  /** "KI: wirkt ändernd" once Clef labelled it. */
  label: string | null;
  /** The Clef label is still to come (not "unauffällig" yet). */
  pending: boolean;
}

export interface ToolsView {
  upstream: { id: number; name: string; defaultPolicy: Policy; status: UpstreamStatus; auth: UpstreamAuth; autoRule: string | null };
  /** Clients that can reach this upstream (OAuth, its tokens, all-upstreams
   * tokens); paused ones included (TC-127). */
  clients: { id: number; name: string; paused: boolean }[];
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
  /** ADR-0023: web pages that may use this token from a browser (TOKEN only; [] for OAuth). */
  allowedOrigins: string[];
  /** ADR-0024: since when the access is paused (ISO); null = active. */
  pausedAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

/** An upstream that needs the user (ADR-0022): a "Störung" card on Freigaben. */
export interface UpstreamFault {
  id: number;
  name: string;
  state: 'reconnect' | 'unreachable';
  /** Since when it fails (unreachable only), ISO; else null. */
  since: string | null;
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

/** ADR-0025: the advisory intent summary of a call. OFF = feature off,
 * PENDING = being made, DONE, FAILED, SKIPPED (not made). */
export type IntentStatus = 'OFF' | 'PENDING' | 'DONE' | 'FAILED' | 'SKIPPED';
export type IntentRisk = 'read' | 'write' | 'destructive';

export interface IntentFields {
  intentStatus: IntentStatus;
  /** TC-126: 3-5 word AI title (DONE only). Model output: text only. */
  intentTitle?: string | null;
  /** Model output from agent-controlled input: render as text only. */
  intentSummary: string | null;
  /** Shown risk: never below the tool's own hint. */
  intentRisk: IntentRisk | null;
  /** The model rated lower than the tool's hint. */
  intentLowered: boolean | null;
}

/** Audit rows also say when and by which model. */
export interface AuditIntentFields extends IntentFields {
  intentAt: string | null;
  intentModel: string | null;
}

export interface PendingApproval extends IntentFields {
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
  /** ADR-0029: the AI check sent this paused call back; null otherwise. */
  pauseCheck?: PauseCheckView | null;
  /** ADR-0031: the review hint of a new/changed tool (advisory), or null. */
  toolReview?: { attention: boolean; reasons: string[]; label: string | null } | null;
  /** ADR-0030: why an AUTO call is asked; null otherwise. */
  autoCheck?: AutoCheckView | null;
  /** ADR-0026 amendment: asked because Clef judged it outside the Sperre's purpose. */
  sperreCheck?: { purpose: string; score: number } | null;
}

export type Outcome = 'PENDING' | 'FORWARDED' | 'DENIED' | 'TIMED_OUT' | 'UPSTREAM_ERROR';

export interface ResolvedApproval extends AuditIntentFields {
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
  /** ADR-0026: deny and pause (this tool or the whole upstream). */
  | { decision: 'deny'; snoozeMinutes?: number; snoozeUntilMidnight?: boolean; snoozeScope: 'tool' | 'upstream'; purpose?: string }
  /** `purpose`: the optional "Wofür?" of the Zeitfreigabe (ADR-0029 amendment). */
  | { decision: 'approve'; snoozeMinutes?: number; snoozeUntilMidnight?: boolean; snoozeScope?: SnoozeScope; purpose?: string };

/** An active pause on an upstream (ADR-0026, TC-124): allow or deny. */
export interface Pause {
  id: number;
  effect: 'ALLOW' | 'DENY';
  scope: 'TOOL' | 'READONLY' | 'UPSTREAM';
  toolName: string | null;
  mcpClientId: number;
  clientName: string;
  until: string;
  createdAt: string;
  /** ADR-0029 amendment: the "Wofür?" of an allow pause, or null. */
  purpose?: string | null;
}

/** What a snooze covers (TC-76). */
export type SnoozeScope = 'tool' | 'readonly' | 'upstream';

export interface AuditRow extends AuditIntentFields {
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
  /** ADR-0029: p(gleich) and the verdict label of the AI check, if any. */
  pauseCheckScore: number | null;
  pauseCheckChoice: string | null;
  /** ADR-0029 amendment: the Zeitfreigabe's "Wofür?" it was checked against. */
  pausePurpose?: string | null;
  /** ADR-0026 amendment: p(outside) of a Sperre's purpose check, or null. */
  sperreScore?: number | null;
  /** ADR-0030: p(erlaubt) of the AUTO check, or null. */
  autoScore?: number | null;
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

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (signal?.aborted) throw e;
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
  /** ADR-0029: the user's "KI-Prüfung für Zeitfreigaben" switch. */
  setPauseCheck: (on: boolean) => request<Me>('PATCH', '/api/me', { pauseCheck: on }),
  listUpstreams: () => request<Upstream[]>('GET', '/api/upstreams'),
  createUpstream: (input: UpstreamInput) => request<Upstream>('POST', '/api/upstreams', input),
  updateUpstream: (id: number, patch: Partial<UpstreamInput>) =>
    request<Upstream>('PATCH', `/api/upstreams/${id}`, patch),
  deleteUpstream: (id: number) => request<void>('DELETE', `/api/upstreams/${id}`),
  listMcpClients: () => request<McpClient[]>('GET', '/api/mcp/clients'),
  renameMcpClient: (id: number, name: string) => request<McpClient>('PATCH', `/api/mcp/clients/${id}`, { name }),
  revokeMcpClient: (id: number) => request<void>('DELETE', `/api/mcp/clients/${id}`),
  /** The response is the only one that ever contains the token. */
  createUpstreamToken: (id: number, name: string, allowedOrigins: string[] = []) =>
    request<{ client: McpClient; token: string }>('POST', `/api/upstreams/${id}/tokens`, { name, allowedOrigins }),
  createAllUpstreamsToken: (name: string, allowedOrigins: string[] = []) =>
    request<{ client: McpClient; token: string }>('POST', '/api/mcp/tokens', { name, allowedOrigins }),
  /** ADR-0023: replaces a token's browser origins (also with []). */
  setClientOrigins: (id: number, allowedOrigins: string[]) =>
    request<McpClient>('PATCH', `/api/mcp/clients/${id}`, { allowedOrigins }),
  /** ADR-0024: pause (true) or resume (false) an access, TOKEN or OAuth. */
  setClientPaused: (id: number, paused: boolean) => request<McpClient>('PATCH', `/api/mcp/clients/${id}`, { paused }),
  getHealth: () => request<{ status: string; version: string }>('GET', '/api/health'),
  getMcpConfig: () => request<{ configured: boolean }>('GET', '/api/mcp/config'),
  connectUpstream: (id: number) => request<{ authorizationUrl: string }>('POST', `/api/upstreams/${id}/connect`),
  getTools: (id: number) => request<ToolsView>('GET', `/api/upstreams/${id}/tools`),
  refreshTools: (id: number) => request<ToolsView>('POST', `/api/upstreams/${id}/tools/refresh`),
  setToolPolicy: (id: number, toolId: number, policy: Policy | null) =>
    request<ToolsView>('PATCH', `/api/upstreams/${id}/tools/${toolId}`, { policy }),
  /** ADR-0031: "Alle unauffälligen bestätigen" (the server decides which). */
  acknowledgeUnremarkable: (id: number) =>
    request<{ acknowledged: number; view: ToolsView }>('POST', `/api/upstreams/${id}/tools/acknowledge-unremarkable`),
  /** ADR-0030: "Vorschlag" (nothing is saved). */
  draftAutoRule: (id: number) => request<{ draft: string }>('POST', `/api/upstreams/${id}/auto-rule/draft`),
  /** ADR-0030: "Mit Verlauf testen": the rows, then one test per row. */
  autoRuleHistory: (id: number) =>
    request<{ available: boolean; entries: { id: number; tool: string; receivedAt: string; outcome: Outcome }[] }>('GET', `/api/upstreams/${id}/auto-rule/history`),
  testAutoRule: (id: number, rule: string, auditId: number, signal?: AbortSignal) =>
    request<{ auditId: number; result: 'pass' | 'below' | 'error'; score: number | null }>('POST', `/api/upstreams/${id}/auto-rule/test`, { rule, auditId }, signal),
  acknowledgeTool: (id: number, toolId: number) =>
    request<ToolsView>('POST', `/api/upstreams/${id}/tools/${toolId}/acknowledge`),
  setClientPolicy: (id: number, toolId: number, clientId: number, policy: Policy) =>
    request<ToolsView>('PUT', `/api/upstreams/${id}/tools/${toolId}/clients/${clientId}`, { policy }),
  clearClientPolicy: (id: number, toolId: number, clientId: number) =>
    request<ToolsView>('DELETE', `/api/upstreams/${id}/tools/${toolId}/clients/${clientId}`),
  listPauses: (id: number) => request<Pause[]>('GET', `/api/upstreams/${id}/snoozes`),
  liftPause: (id: number, pauseId: number) => request<Pause[]>('DELETE', `/api/upstreams/${id}/snoozes/${pauseId}`),
  listApprovals: () => request<PendingApproval[]>('GET', '/api/approvals'),
  listUpstreamFaults: () => request<UpstreamFault[]>('GET', '/api/upstreams/faults'),
  getApproval: (id: string) => request<PendingApproval | ResolvedApproval>('GET', `/api/approvals/${encodeURIComponent(id)}`),
  decideApproval: (id: string, d: ApprovalDecision) =>
    request<{ id: string; state: 'approved' | 'denied'; snoozeUntil: string | null; alsoDecided?: number }>('POST', `/api/approvals/${encodeURIComponent(id)}`, {
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

export const POLICY_LABEL: Record<Policy, string> = { ALLOW: 'Erlauben', AUTO: 'Auto', ASK: 'Fragen', DENY: 'Verbieten' };
/** The choices, weakest first (ADR-0030: Auto sits between Erlauben and Fragen). */
export const POLICIES: Policy[] = ['ALLOW', 'AUTO', 'ASK', 'DENY'];

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
  snooze: 'Zeitfreigabe, ohne Nachfrage',
  'snooze-deny': 'gesperrt (Ablehnen und nicht mehr fragen)',
  ki: 'KI-Prüfung: passt',
  'snooze-ki-mismatch': 'Zeitfreigabe, KI-Prüfung: weicht ab – Zeitfreigabe beendet',
  'snooze-ki-error': 'Zeitfreigabe, KI-Prüfung nicht erreichbar',
  'approved:page': 'erlaubt in der App',
  'approved:push': 'erlaubt per Benachrichtigung',
  'denied:page': 'abgelehnt in der App',
  'denied:push': 'abgelehnt per Benachrichtigung',
  'approved:pause': 'erlaubt durch Zeitfreigabe',
  'denied:pause': 'durch Sperre abgelehnt',
  timeout: 'Zeit abgelaufen',
  aborted: 'Verbindung abgebrochen',
  shutdown: 'Server neu gestartet',
  restart: 'Server neu gestartet',
  revoked: 'Client oder Upstream entfernt',
  paused: 'Zugang pausiert',
  flood: 'zu viele offene Freigaben',
  'ask:no-channel': 'Freigabe noch nicht verfügbar',
  auto: 'Auto-Regel: von der KI gedeckt',
  'auto-ask': 'Auto-Regel: nicht eindeutig gedeckt',
  'auto-error': 'Auto-Regel: KI-Prüfung nicht erreichbar',
  'auto-off': 'Auto-Regel: KI-Prüfung aus',
  'auto-norule': 'Auto ohne Regeltext',
  'snooze-deny-ki-ask': 'Sperre, KI-Prüfung: fällt nicht darunter – gefragt',
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

/** One origin per line (blank lines ignored), as the origin fields take them. */
export function originLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
}
