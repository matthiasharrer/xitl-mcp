import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Pure SPA (no SvelteKit). The dev server proxies /api to the Hono backend so
// the browser talks to a single origin — no CORS needed.
export default defineConfig({
  plugins: [svelte()],
  server: {
    // WEB_PORT lets xitl take 5173 when rezepte is stopped (scripts/app.sh).
    port: Number(process.env.WEB_PORT ?? 5175),
    strictPort: true,
    // Bind to all interfaces so the Coder workspace can forward the port.
    host: true,
    // Reached through the Coder proxy, whose hostname isn't localhost; Vite
    // would otherwise block it ("This host is not allowed"). Leading dot
    // matches all subdomains.
    allowedHosts: ['.proxy.coder.hamathy.de'],
    // The Coder proxy terminates TLS and serves each port over 443; point the
    // HMR client there. (Causes benign :443 websocket errors on local access.)
    hmr: { clientPort: 443 },
    proxy: {
      // In production Hono serves the SPA itself, so this only runs in dev.
      // Real deployments get Remote-* headers from Authelia's ForwardAuth at
      // the ingress; here we fake them. Each is overridable via env
      // (DEV_REMOTE_USER/_NAME/_EMAIL/_GROUPS); an empty string removes the
      // header entirely (reproduces the "no identity" -> 401 state). Whatever
      // the browser sent is overwritten, mirroring Traefik.
      '/api': {
        target: 'http://localhost:3002',
        xfwd: true,
        configure(proxy) {
          proxy.on('proxyReq', (proxyReq) => {
            const fakes: [string, string][] = [
              ['Remote-User', process.env.DEV_REMOTE_USER ?? 'matthias'],
              ['Remote-Name', process.env.DEV_REMOTE_NAME ?? 'Matthias (dev)'],
              ['Remote-Email', process.env.DEV_REMOTE_EMAIL ?? 'matthias@example.invalid'],
              ['Remote-Groups', process.env.DEV_REMOTE_GROUPS ?? 'admins'],
            ];
            for (const [header, value] of fakes) {
              // Strip any client-supplied copy first, then set ours (or none).
              proxyReq.removeHeader(header);
              if (value !== '') proxyReq.setHeader(header, value);
            }
          });
        },
      },
    },
  },
});
