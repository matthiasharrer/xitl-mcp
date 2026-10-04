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

export interface McpClient {
  id: number;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
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
};

export const messageOf = (e: unknown) =>
  e instanceof ApiError ? e.message : 'Das hat nicht geklappt. Bitte versuche es noch einmal.';

export const STATUS_LABEL: Record<UpstreamStatus, string> = {
  NOT_CONNECTED: 'Nicht verbunden',
  CONNECTED: 'Verbunden',
  NEEDS_RECONNECT: 'Neu verbinden nötig',
};
