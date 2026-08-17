# Stream proxy (Deno Deploy / Vercel)

The Xtream panels that power this app 302 their live/VOD/series manifests to an
`http://IP:port` CDN. Problems that prevent a naive solution:

- From an HTTPS page, the `http://` redirect is blocked as **mixed content**.
- The panels **and** that CDN return **403 to Cloudflare IPs**, so the Cloudflare
  Pages Function can't reach them.
- The CDN's TLS certificate is **invalid**, so the browser can't load its
  `https://` directly either.

This small server runs **outside Cloudflare** (Deno Deploy = GCP, or Vercel =
AWS) to proxy the **whole stream**:

1. Follows the panel's redirect chain server-side.
2. Rewrites every playlist URI so it routes **back through the proxy**.
3. Streams the TS/MP4 segments to the browser over the proxy's own **valid
   HTTPS**. The browser never talks to the untrusted `http://IP` CDN.

## Endpoint

```
GET /?target=<encodeURIComponent("https://panel/live/U/P/ID.m3u8")>
GET /api/stream-proxy?target=<...>   (Vercel)
```

Requires an http(s) url in `target`. Returns the rewritten playlist (manifest
URIs point back to the proxy), or the upstream bytes, with relaxed CORS headers.

## Deploy on Deno Deploy

1. Create a project at https://dash.deno.com .
2. Deploy this repo with entrypoint `stream-proxy/mod.ts`.
3. You get a URL like `https://<project>.deno.dev`.

## Deploy on Vercel

1. Keep `api/stream-proxy.js` under `api/`.
2. Deploy the repo to a Vercel project.
3. Route: `https://<project>.vercel.app/api/stream-proxy`.

## Point the web app at it

Pass the deployed URL(s) at build time. **Use several proxies** across different
clouds because panels/CDNs 403 different IP ranges (e.g. some block Cloudflare
AND AWS but not GCP). Comma-separated list, tried in order:

```bash
VITE_STREAM_PROXY_URLS="https://<project>.deno.dev,https://<project>.vercel.app/api/stream-proxy" npm run build
# single URL still works:
# VITE_STREAM_PROXY_URLS=https://<project>.deno.dev npm run build
```

Player fallback order: each external proxy (in order) -> direct -> Cloudflare
Pages `/proxy`. Exclusivos streams keep their own dynamic proxy and are untouched.
