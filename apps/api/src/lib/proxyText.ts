// Pure text shaping for the proxy (ADR-0014): the approval stamp on listed
// tools, the read/write hint, the instructions prefix, the agent-facing
// messages, the audit's result excerpt and the secret scrubber. Unit tested in
// proxyText.test.ts.

/** First line of every proxied endpoint's server instructions. */
export const INSTRUCTIONS_PREFIX =
  'Über xitl vermittelt: manche Tools brauchen eine Freigabe. / Proxied by xitl: some tools need approval.';

export function instructionsFor(upstreamInstructions: string | null | undefined, fallback: string): string {
  const own = upstreamInstructions?.trim() || fallback.trim();
  return own ? `${INSTRUCTIONS_PREFIX}\n\n${own}` : INSTRUCTIONS_PREFIX;
}

/** Per-upstream cap on its own instructions inside the unified text. */
export const UNIFIED_SECTION_MAX = 4000;

export interface UnifiedSection {
  slug: string;
  name: string;
  description: string | null;
  /** The upstream's own server instructions (stored/live, already scrubbed). */
  instructions: string | null;
  /** Usable without a connect step (connection.isUsable). */
  usable: boolean;
}

/** Server instructions of the unified `/mcp` (ADR-0014, ADR-0017): the xitl
 * line, the naming rule, then one section per upstream. */
export function unifiedInstructions(sections: UnifiedSection[]): string {
  const parts = [
    INSTRUCTIONS_PREFIX,
    'Alle Upstreams in einem Endpunkt: Tool-Namen beginnen mit dem Kürzel des Upstreams (`<kürzel>_<tool>`). ' +
      '/ All upstreams in one endpoint: tool names start with the upstream\'s slug (`<slug>_<tool>`).',
  ];
  for (const s of sections) {
    const lines = [`## ${s.name} — Tools \`${s.slug}_…\``];
    if (!s.usable) {
      lines.push('(In xitl nicht verbunden: zurzeit keine Tools. / Not connected in xitl: no tools right now.)');
    } else {
      const description = s.description?.trim();
      if (description) lines.push(description);
      const own = s.instructions?.trim();
      if (own) lines.push(own.length > UNIFIED_SECTION_MAX ? own.slice(0, UNIFIED_SECTION_MAX - 1) + '…' : own);
    }
    parts.push(lines.join('\n\n'));
  }
  return parts.join('\n\n');
}

/** The ASK stamp appended to a tool's description (ADR-0014). */
export function askStamp(displayName: string): string {
  return (
    `\n\n[xitl] Erfordert Freigabe durch ${displayName}; die Antwort kann bis zu 5 Minuten dauern. ` +
    `/ Requires approval by ${displayName}; may take up to 5 minutes.`
  );
}

export function stampedDescription(description: string | undefined, displayName: string): string {
  return `${description ?? ''}${askStamp(displayName)}`;
}

export type ToolHint = 'read' | 'write' | 'destructive';

/** Read/write classification from MCP tool annotations (ADR-0004), shown in the
 * UI only. readOnlyHint wins; destructiveHint must be explicitly true to show
 * "destructive"; everything else (incl. no annotations) is "write". */
export function toolHint(annotations: unknown): ToolHint {
  const a = (annotations && typeof annotations === 'object' ? annotations : {}) as Record<string, unknown>;
  if (a.readOnlyHint === true) return 'read';
  if (a.destructiveHint === true) return 'destructive';
  return 'write';
}

export const RESULT_TEXT_MAX = 2000;

/** A short text excerpt of a CallToolResult for the audit (≤ 2000 chars):
 * the text blocks joined, else the JSON. */
export function resultExcerpt(result: unknown): string {
  let text = '';
  const content = (result as { content?: unknown })?.content;
  if (Array.isArray(content)) {
    text = content
      .map((b) => (b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : ''))
      .filter(Boolean)
      .join('\n');
  }
  if (!text) {
    try {
      text = JSON.stringify(result) ?? '';
    } catch {
      text = '';
    }
  }
  return text.length > RESULT_TEXT_MAX ? text.slice(0, RESULT_TEXT_MAX - 1) + '…' : text;
}

/** Secrets shorter than this are not scrubbed (too likely to hit ordinary text). */
const MIN_SECRET_LEN = 8;

/** Defence in depth (ADR-0007/0013, TC-18): replace any of our upstream
 * credentials that an upstream echoes back inside a result before it reaches
 * the agent. Returns the input unchanged (same object) when nothing matched. */
export function scrubSecrets<T>(value: T, secrets: (string | null | undefined)[]): T {
  const live = secrets.filter((s): s is string => typeof s === 'string' && s.length >= MIN_SECRET_LEN);
  if (live.length === 0) return value;
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return value;
  }
  if (!live.some((s) => json.includes(JSON.stringify(s).slice(1, -1)))) return value;
  let out = json;
  for (const s of live) out = out.split(JSON.stringify(s).slice(1, -1)).join('[xitl: entfernt]');
  return JSON.parse(out) as T;
}

/** isError results the proxy itself produces (never upstream internals). */
export function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

export const MSG = {
  denied: (tool: string) =>
    `[xitl] Verweigert: Das Tool „${tool}“ ist für diesen Client nicht erlaubt. / Denied: tool "${tool}" is not allowed for this client by the user's policy.`,
  unknownTool: (tool: string) =>
    `[xitl] Verweigert: Das Tool „${tool}“ ist nicht bekannt. / Denied: unknown tool "${tool}". List the tools first.`,
  declined: (tool: string, by: string) =>
    `[xitl] Abgelehnt: ${by} hat den Aufruf von „${tool}“ abgelehnt. / Declined: ${by} declined the call to "${tool}".`,
  timedOut: (tool: string) =>
    `[xitl] Verweigert: Der Aufruf von „${tool}“ wurde nicht innerhalb von 5 Minuten freigegeben; bitte später erneut versuchen. / Denied: the call to "${tool}" was not approved within 5 minutes; try again later.`,
  approvalCancelled: (tool: string) =>
    `[xitl] Verweigert: Die Freigabe für „${tool}“ wurde abgebrochen (Verbindung beendet oder Server neu gestartet); bitte später erneut versuchen. / Denied: approval for "${tool}" was cancelled; try again later.`,
  revoked: (tool: string) =>
    `[xitl] Verweigert: Die Freigabe für „${tool}“ wurde beendet, weil der Client widerrufen oder der Upstream entfernt wurde. / Denied: approval for "${tool}" ended because the client was revoked or the upstream removed.`,
  flood: (tool: string) =>
    `[xitl] Verweigert: Zu viele offene Freigaben; „${tool}“ wurde nicht zur Freigabe vorgelegt. Bitte warten, bis offene Freigaben entschieden sind. / Denied: too many pending approvals; the call to "${tool}" was not queued. Wait for pending approvals to be decided.`,
  reconnect: (name: string) =>
    `Upstream „${name}“ muss in xitl neu verbunden werden. / Upstream "${name}" must be reconnected in xitl.`,
  notConnected: (name: string) =>
    `Upstream „${name}“ ist in xitl noch nicht verbunden. / Upstream "${name}" is not connected in xitl yet.`,
  upstreamError: (name: string) =>
    `[xitl] Upstream „${name}“ ist gerade nicht erreichbar oder hat einen Fehler gemeldet. / Upstream "${name}" is unavailable or returned an error.`,
};
