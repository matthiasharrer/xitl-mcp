// The background labeller (ADR-0031 §3). After a sync (upstream/tools.ts
// onToolsSynced) it looks for that upstream's tools awaiting review (new or
// changed) whose label belongs to an older definition (`hintFor` !=
// versionKey), and asks Clef once per (tool, version), one tool at a time
// process-wide. NEVER on the call path: nothing awaits it, nothing on the
// decision path reads its result; it only writes hintRisk / hintInjection /
// hintAt / hintFor, and only if the definition is still the one it labelled.
//
// Off (no request at all) when Clef isn't configured or the owner's switch
// (User.pauseCheck, "KI-Prüfung (Clef)") is off; such tools keep no label and
// are labelled on a later sync once it is on. A failed request leaves that
// part of the label empty and still marks the version done (once per
// version; no retry storm against a down Clef). Failures are logged by class
// only and do not raise the outage notice (the label is advisory; the notice
// is about calls being asked again).
import { prisma } from '../db.js';
import { systemClock, type Clock } from '../lib/clock.js';
import { withTimeout, type ClefConfig } from '../clef/client.js';
import { parseJson, parseStoredSchema, versionKey } from './defs.js';
import { injectionQuestions, injectionState, parseInjection, parseRisk, riskQuestions, riskState, type LabelInput } from './label.js';

export class HintQueue {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly inFlight = new Set<string>();
  private readonly clock: Clock;
  private readonly log: (l: string) => void;

  constructor(
    private readonly config: ClefConfig | null,
    opts: { clock?: Clock; log?: (l: string) => void } = {},
  ) {
    this.clock = opts.clock ?? systemClock;
    this.log = opts.log ?? ((l) => console.log(l));
  }

  get enabled(): boolean {
    return this.config !== null;
  }

  /** Fire and forget; never throws. Resolves when this upstream's pass ran
   * (tests await it). */
  schedule(upstreamId: number): Promise<void> {
    if (!this.config) return Promise.resolve();
    const run = this.chain.then(() => this.pass(upstreamId)).catch((e) => console.warn(`tool hint: pass failed: ${e instanceof Error ? e.name : 'unknown'}`));
    this.chain = run;
    return run;
  }

  private async pass(upstreamId: number): Promise<void> {
    const config = this.config;
    if (!config) return;
    const up = await prisma.upstream.findUnique({ where: { id: upstreamId }, select: { user: { select: { pauseCheck: true } } } });
    if (up?.user.pauseCheck !== true) return;
    const rows = await prisma.knownTool.findMany({
      where: { upstreamId, OR: [{ acknowledgedAt: null }, { changedAt: { not: null } }] },
      select: { id: true, name: true, description: true, annotations: true, inputSchema: true, hintFor: true },
      orderBy: { id: 'asc' },
    });
    for (const r of rows) {
      const version = versionKey(r);
      if (r.hintFor === version) continue;
      const key = `${r.id}:${version}`;
      if (this.inFlight.has(key)) continue;
      this.inFlight.add(key);
      try {
        await this.label(config, r, version);
      } finally {
        this.inFlight.delete(key);
      }
    }
  }

  private async label(
    config: ClefConfig,
    r: { id: number; name: string; description: string | null; annotations: string | null; inputSchema: string | null },
    version: string,
  ): Promise<void> {
    const input: LabelInput = { name: r.name, description: r.description, annotations: parseJson(r.annotations), inputSchema: parseStoredSchema(r.inputSchema) };
    const started = this.clock.now().getTime();
    const risk = await withTimeout(config.timeoutMs, async (signal) => parseRisk(await config.client.ask(riskState(input), riskQuestions(), signal)));
    const inj = await withTimeout(config.timeoutMs, async (signal) => parseInjection(await config.client.ask(injectionState(input), injectionQuestions(), signal)));
    const fail = (x: { error: unknown; timedOut: boolean }) => (x.timedOut ? 'timeout' : x.error instanceof Error ? x.error.name : 'unknown');
    if ('error' in risk) console.warn(`tool hint: risiko failed (${fail(risk)})`);
    if ('error' in inj) console.warn(`tool hint: injektion failed (${fail(inj)})`);
    // Only if the row still holds the definition that was labelled.
    await prisma.knownTool.updateMany({
      where: { id: r.id, description: r.description, annotations: r.annotations, inputSchema: r.inputSchema },
      data: {
        hintRisk: 'value' in risk ? risk.value : null,
        hintInjection: 'value' in inj ? inj.value : null,
        hintAt: this.clock.now(),
        hintFor: version,
      },
    });
    this.log(`tool hint: labelled in ${this.clock.now().getTime() - started} ms`);
  }
}
