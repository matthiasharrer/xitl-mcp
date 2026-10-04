// Browser side of Web Push (ADR-0009), copied from haushalts-todos. The
// service worker is /sw.js.
import { api } from './api';

export function pushSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof PushManager !== 'undefined' &&
    typeof Notification !== 'undefined'
  );
}

export function pushPermission(): NotificationPermission {
  return typeof Notification === 'undefined' ? 'denied' : Notification.permission;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

function keyToBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Asks for permission if needed, subscribes this device and registers it with the server. */
export async function subscribeThisDevice(): Promise<PushSubscription> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('permission-denied');
  const registration = await navigator.serviceWorker.ready;
  let sub = await registration.pushManager.getSubscription();
  if (!sub) {
    const { publicKey } = await api.getPushConfig();
    sub = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyToBytes(publicKey),
    });
  }
  const json = sub.toJSON();
  await api.savePushSubscription({
    endpoint: sub.endpoint,
    keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' },
  });
  return sub;
}

export async function unsubscribeThisDevice(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await api.deletePushSubscription(sub.endpoint).catch(() => {}); // the server row may already be gone
  await sub.unsubscribe();
}

/** ADR-0009: "the PWA detects stale subscriptions and re-registers". On app
 * start, if this browser holds a subscription, (re)register it with the
 * server; cheap and idempotent (upsert by endpoint). */
export async function refreshSubscription(): Promise<void> {
  if (!pushSupported() || pushPermission() !== 'granted') return;
  const sub = await currentSubscription();
  if (!sub) return;
  const json = sub.toJSON();
  await api.savePushSubscription({ endpoint: sub.endpoint, keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' } });
}

export async function sendTestPush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) throw new Error('no-subscription');
  await api.sendPushTest(sub.endpoint);
}
