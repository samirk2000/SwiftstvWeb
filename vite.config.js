import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Cloudflare Pages: build command `npm run build`, output dir `dist`.
// Routing is client-side (react-router BrowserRouter); Pages supports SPA
// fallback via the included `public/_redirects` + Pages Functions note below.
// Rewrites every media/sub-playlist URI in an HLS playlist to `/proxy?target=`
// so the browser stays same-origin (HTTPS in prod / localhost in dev) for the
// whole stream. Mirrors `rewritePlaylist` in `functions/proxy.js`.
function rewritePlaylist(text, resolvedUrl, origin) {
  if (!text) return text;
  const base = new URL(resolvedUrl);
  return text
    .split(/\r?\n/)
    .map((line) => {
      const tl = line.trim();
      if (!tl || tl.startsWith('#') || tl.startsWith('http')) return line;
      if (/^\/proxy/i.test(tl)) return line;
      let abs;
      try {
        abs = new URL(tl, base).toString();
      } catch {
        return line;
      }
      return `${origin}/proxy?target=${encodeURIComponent(abs)}`;
    })
    .join('\n');
}

// Dev twin of the Cloudflare Pages Function in `functions/proxy.js`. Same
// `/proxy?target=` protocol; this middleware performs the server-side fetch
// (with relaxed CORS + HLS playlist rewriting) so `npm run dev` behaves
// identically to production.
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
          const ct = upstream.headers.get('content-type') || 'application/octet-stream';
          let body;
          if (/mpegurl/.test(ct)) {
            body = Buffer.from(rewritePlaylist(await upstream.text(), upstream.url, 'http://localhost'));
          } else {
            body = Buffer.from(await upstream.arrayBuffer());
          }
          res.writeHead(upstream.status, {
            'Content-Type': ct,
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
