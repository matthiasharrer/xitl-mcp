// /api/me: who is signed in (Authelia), plus the user's own settings.
//
//   GET   /   { id, username, displayName, pauseCheck, pauseCheckAvailable }
//   PATCH /   { pauseCheck: boolean } -> the same shape
//
// `pauseCheck` (ADR-0029): "KI-Prüfung für Zeitfreigaben". Only meaningful when
// PAUSE_CHECK_URL is set (`pauseCheckAvailable`); the UI hides the switch
// otherwise. Changeable only here, with Remote-User (identity.ts): there is no
// MCP tool or /mcp path for it, so an agent can't turn its own check off.
// Turning it off clears the user's outage card.
import { Hono } from 'hono';
import { z } from 'zod';
import { prisma } from '../db.js';
import type { AppEnv } from '../identity.js';
import { pauseGate as defaultPauseGate } from '../pausecheck/index.js';
import type { PauseGate } from '../pausecheck/gate.js';

const patchSchema = z.object({ pauseCheck: z.boolean() }).strict();

export function makeMeRoutes(gate: PauseGate = defaultPauseGate) {
  const me = new Hono<AppEnv>();
  const view = (u: { id: number; username: string; displayName: string; pauseCheck: boolean }) => ({
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    pauseCheck: u.pauseCheck,
    pauseCheckAvailable: gate.enabled,
  });

  me.get('/', (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json(view(c.get('user')));
  });

  me.patch('/', async (c) => {
    c.header('Cache-Control', 'no-store');
    const parsed = patchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Die Einstellung ist ungültig.' }, 400);
    const user = await prisma.user.update({ where: { id: c.get('user').id }, data: { pauseCheck: parsed.data.pauseCheck } });
    if (!user.pauseCheck) gate.outage.cleared(user.id);
    return c.json(view(user));
  });
  return me;
}

export const me = makeMeRoutes();
