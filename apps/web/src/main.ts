import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';
import { refreshSubscription } from './lib/push';
import { watchForUpdates } from './lib/appUpdate.svelte';

// Service worker for Web Push only (ADR-0009): no caching, no fetch handler.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .register('/sw.js')
    .then(() => refreshSubscription())
    .catch((e) => console.warn('service worker / push refresh failed', e));
}

export default mount(App, { target: document.getElementById('app')! });

// Offer a reload when a deploy shipped a newer build (ADR-0035).
watchForUpdates();
