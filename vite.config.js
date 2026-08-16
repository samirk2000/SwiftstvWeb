import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Cloudflare Pages: build command `npm run build`, output dir `dist`.
// Routing is client-side (react-router BrowserRouter); Pages supports SPA
// fallback via the included `public/_redirects` + Pages Functions note below.
// Dev twin of the Cloudflare Pages Function in `functions/proxy.js`. Same
// `/proxy?target=` protocol; this middleware performs the server-side fetch
// (with relaxed CORS) so `npm run dev` behaves identically to production.
function devProxy() {
  return {
    name: 'swiftstv-dev-cors-proxy',
    configureServer(server) {
      server.middlewares.use('/proxy', async (req, res) => {
        try {
          const u = new URL(req.url, 'http://localhost');
          const target = u.searchParams.get('target');
          const ua = u.searchParams.get('ua') || 'IPTVSmartersPlayer';
          const referer = u.searchParams.get('referer') || '';
          const origin = u.searchParams.get('origin') || '';

          if (!target) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'missing "target"' }));
            return;
          }
          const t = new URL(target.trim());
          if (t.protocol !== 'http:' && t.protocol !== 'https:') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'bad target protocol' }));
            return;
          }

          const hdrs = {
            'User-Agent': ua,
            Accept: '*/*',
            'Cache-Control': 'no-cache',
            Pragma: 'no-cache',
          };
          if (referer) hdrs.Referer = referer;
          if (origin) hdrs.Origin = origin;

          const upstream = await fetch(t.toString(), { headers: hdrs, redirect: 'follow' });
          const body = Buffer.from(await upstream.arrayBuffer());
          res.writeHead(upstream.status, {
            'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': '*',
          });
          res.end(body);
        } catch (err) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'upstream', detail: String(err?.message || err) }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), devProxy()],
  build: {
    outDir: 'dist',
    target: 'es2018', // broad Smart-TV browser support (older webviews without modules)
  },
  server: {
    port: 5173,
    host: true, // expose on the LAN so Smart TVs / phones can reach it
  },
  esbuild: {
    // hls.js ships prebuilt ESM; keep even older TV/webview syntax in check.
    target: 'es2018',
  },
});
