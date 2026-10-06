// xitl service worker (ADR-0009): Web Push only. No fetch handler and no
// caching on purpose (copied stance from haushalts-todos: a caching worker
// behind Authelia is a trap); the app is never served from here.
//
// Messages (apps/api/src/lib/push.ts PushMessage):
//   approval  -> a notification per held call (tag approval-<id>) with the
//                actions "Erlauben" / "Ablehnen" where the platform supports
//                them; tapping the body opens /#/freigabe/<id> (iPhones show no
//                actions, so that path must always work).
//                With `update: true` (ADR-0025) it is the same call again,
//                now with the advisory `intent` and `risk`: it replaces the
//                notification silently, but ONLY if the open one with that tag
//                is still the request (`data.pending`); an outcome under the
//                same tag, or none at all (decided meanwhile, dismissed): dropped.
//   resolved  -> the call was decided in the app, expired, or ended because
//                its access was revoked / its upstream removed ('revoked') or
//                its access paused ('paused', ADR-0024): replace the
//                notification with the outcome (same tag, silent).
//   upstream  -> an upstream became unreachable or needs a reconnect
//                (ADR-0022): one notification per upstream (tag
//                upstream-<id>, a newer one replaces it); tapping opens
//                Freigaben, where its "Störung" card is.
//   test      -> the "Test-Push" from Einstellungen.
//
// An action makes the SAME request the app does (TC-33):
//   POST /api/approvals/<id> {decision, via:'push'} with the Authelia cookie.
// If the session has expired, Authelia answers with a redirect; we never
// follow it (redirect: 'manual') and ask the user to open the app instead.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

const ICON = '/icon-192.png';
const approvalUrl = (id) => `/#/freigabe/${encodeURIComponent(id)}`;
const tagOf = (id) => `approval-${id}`;

function timeOf(iso) {
  try {
    return new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });
  } catch {
    return '';
  }
}

function show(title, options) {
  return self.registration.showNotification(title, { icon: ICON, badge: ICON, ...options });
}

const RISK_TEXT = { read: 'Lesen', write: 'Schreiben', destructive: 'Destruktiv' };

const OUTCOME_TEXT = {
  approved: 'Erlaubt',
  denied: 'Abgelehnt',
  expired: 'Zeit abgelaufen',
  revoked: 'Nicht mehr offen: Zugang oder Upstream entfernt',
  paused: 'Nicht mehr offen: Zugang pausiert',
  gone: 'Nicht mehr offen',
  login: 'Nicht entschieden: bitte in der App anmelden',
  error: 'Nicht entschieden: bitte in der App entscheiden',
};

function showOutcome(id, outcome, label) {
  const text = OUTCOME_TEXT[outcome] || OUTCOME_TEXT.error;
  return show(text, {
    body: label || 'Tippen für Details.',
    tag: tagOf(id),
    silent: true,
    data: { url: approvalUrl(id), id, label },
  });
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  if (data.type === 'approval' && typeof data.id === 'string' && data.update === true) {
    event.waitUntil(
      self.registration.getNotifications({ tag: tagOf(data.id) }).then((open) => {
        // Only a still-open request: an outcome ("Erlaubt" after the lock-screen
        // button) carries the same tag and must not turn back into a request.
        const current = open[open.length - 1];
        if (!current || !current.data || current.data.pending !== true) return undefined;
        const label = `${data.upstream || ''} · ${data.summary || data.tool || ''}`;
        const risk = RISK_TEXT[data.risk] || '';
        const intent = String(data.intent || '').slice(0, 200);
        const until = timeOf(data.expiresAt);
        // TC-126: the AI title (plain text, capped) as the body's first line.
        const title = String(data.intentTitle || '').slice(0, 60);
        const body = [title, `${risk ? `${risk}: ` : ''}${intent}`, label, until ? `Offen bis ${until} Uhr` : ''].filter(Boolean).join('\n');
        return show('Freigabe nötig', {
          body,
          tag: tagOf(data.id),
          silent: true,
          renotify: false,
          requireInteraction: true,
          actions: [
            { action: 'approve', title: 'Erlauben' },
            { action: 'deny', title: 'Ablehnen' },
          ],
          data: { url: approvalUrl(data.id), id: data.id, label, pending: true },
        });
      }),
    );
    return;
  }
  if (data.type === 'approval' && typeof data.id === 'string') {
    const label = `${data.upstream || ''} · ${data.summary || data.tool || ''}`;
    const until = timeOf(data.expiresAt);
    event.waitUntil(
      show('Freigabe nötig', {
        body: until ? `${label}\nOffen bis ${until} Uhr` : label,
        tag: tagOf(data.id),
        renotify: true,
        requireInteraction: true,
        actions: [
          { action: 'approve', title: 'Erlauben' },
          { action: 'deny', title: 'Ablehnen' },
        ],
        data: { url: approvalUrl(data.id), id: data.id, label, pending: true },
      }),
    );
    return;
  }
  if (data.type === 'resolved' && typeof data.id === 'string') {
    // Decided elsewhere (app, another device, expired, revoked/paused): the
    // notification just goes away (Matthias, 2026-10-06: no lingering
    // "Erlaubt" notifications).
    event.waitUntil(
      self.registration.getNotifications({ tag: tagOf(data.id) }).then((open) => {
        for (const n of open) n.close();
      }),
    );
    return;
  }
  if (data.type === 'upstream' && (typeof data.upstreamId === 'number' || typeof data.upstreamId === 'string')) {
    const name = `„${String(data.name || 'Upstream')}“`;
    const title = data.state === 'reconnect' ? `${name} muss in xitl neu verbunden werden` : `${name} ist nicht erreichbar`;
    event.waitUntil(
      show(title, {
        body: 'Claude sieht dessen Tools gerade nicht. Tippen für Details.',
        tag: `upstream-${data.upstreamId}`,
        renotify: true,
        data: { url: '/#/' },
      }),
    );
    return;
  }
  event.waitUntil(show(data.title || 'xitl', { body: data.body || '', tag: 'test', data: { url: '/' } }));
});

/** The decision request, identical to the app's (except via). */
async function decide(id, decision) {
  try {
    const res = await fetch(`/api/approvals/${encodeURIComponent(id)}`, {
      method: 'POST',
      credentials: 'include',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision, via: 'push' }),
    });
    if (res.ok) return decision === 'approve' ? 'approved' : 'denied';
    if (res.status === 409) return 'gone';
    if (res.type === 'opaqueredirect' || res.status === 401 || res.status === 0) return 'login';
    return 'error';
  } catch {
    return 'error';
  }
}

function openApp(path) {
  const url = new URL(path || '/', self.location.origin).href;
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
    const open = windows.find((w) => 'focus' in w);
    if (open) return open.focus().then((w) => ('navigate' in w ? w.navigate(url) : w));
    return self.clients.openWindow(url);
  });
}

self.addEventListener('notificationclick', (event) => {
  const n = event.notification;
  const data = n.data || {};
  n.close();
  if ((event.action === 'approve' || event.action === 'deny') && typeof data.id === 'string') {
    // Done: the tapped notification is already closed, nothing stays behind.
    // Not done (gone, login, error): say so, the user has to act.
    event.waitUntil(
      decide(data.id, event.action).then((outcome) =>
        outcome === 'approved' || outcome === 'denied' ? undefined : showOutcome(data.id, outcome, data.label),
      ),
    );
    return;
  }
  event.waitUntil(openApp(data.url));
});
