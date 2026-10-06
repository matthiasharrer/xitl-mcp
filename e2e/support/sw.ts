// Runs the real /sw.js in a Node vm with a minimal ServiceWorkerGlobalScope
// stub, so TC-33 can dispatch push/notificationclick events and capture the
// exact fetch the worker makes (then replay it against the server).
import vm from 'node:vm';

export interface Shown {
  title: string;
  options: any;
  /** closed by the SW (resolved push) or by a tap */
  closed?: boolean;
}
export interface SwFetch {
  url: string;
  init: any;
}

export function loadServiceWorker(source: string, origin: string, respond: (f: SwFetch) => Promise<{ ok: boolean; status: number; type?: string }>) {
  const listeners: Record<string, (e: any) => void> = {};
  const shown: Shown[] = [];
  const fetches: SwFetch[] = [];
  const opened: string[] = [];
  const self = {
    addEventListener: (type: string, fn: (e: any) => void) => (listeners[type] = fn),
    skipWaiting: () => undefined,
    location: { origin },
    registration: {
      showNotification: async (title: string, options: any) => void shown.push({ title, options }),
      // Open ones only; close() marks the entry (real notifications vanish).
      getNotifications: async ({ tag }: { tag: string }) =>
        shown.filter((n) => n.options?.tag === tag && !n.closed).map((n) => ({ data: n.options.data, close: () => void (n.closed = true) })),
    },
    clients: {
      claim: async () => undefined,
      matchAll: async () => [],
      openWindow: async (url: string) => void opened.push(url),
    },
  };
  const fetch = async (url: string, init: any) => {
    const f = { url, init };
    fetches.push(f);
    return respond(f);
  };
  vm.runInNewContext(source, { self, fetch, URL, console });

  async function dispatch(type: string, event: Record<string, unknown>) {
    const waits: Promise<unknown>[] = [];
    listeners[type]!({ ...event, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
  }
  return {
    listeners,
    shown,
    fetches,
    opened,
    push: (payload: unknown) => dispatch('push', { data: { json: () => payload, text: () => JSON.stringify(payload) } }),
    click: (notification: Shown, action = '') =>
      dispatch('notificationclick', { action, notification: { data: notification.options.data, close: () => void (notification.closed = true) } }),
  };
}
