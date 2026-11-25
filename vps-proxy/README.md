# SwiftstvWeb stream proxy — Express on a Hetzner VPS

Server-side stream proxy for the Xtream panels (live / VOD / Series), so the
web frontend never talks to `http://IP` CDNs (mixed content), never hits a CDN
that 403s Cloudflare/AWS, and never fails on a CDN's invalid TLS cert.

Same logic as `api/stream-proxy.js` (Vercel) and `stream-proxy/mod.ts` (Deno),
but as a long-running Express app to run on your own VPS behind PM2 + Nginx.

## What it does

- `GET /stream?target=<encodeURIComponent(url)>`
- Follows the panel's 30x redirects to the CDN (up to 8 hops).
- **Ignores invalid SSL certificates** via
  `new https.Agent({ rejectUnauthorized: false })` (the CDNs are addressed by raw
  IP and serve broken certs).
- Injects **`User-Agent: IPTVSmartersPlayer/1.0`** on every upstream request.
- For **HLS playlists**: rewrites every segment/child-playlist URI to route back
  through this proxy so the browser only talks to our valid HTTPS.
- For **binary** (mp4/TS): streams straight through with **Range passthrough**
  (so `<video>` can seek big VOD files) and CORS headers.
- Responds to `OPTIONS` preflight + exposes `Accept-Ranges`/`Content-Range`.

## Layout

```
vps-proxy/
  proxy.js            # Express proxy (this)
  package.json        # deps (express)
  ecosystem.config.js # PM2
  nginx.conf          # example Nginx site + Certbot
  README.md
```

## Deploy on the VPS

Requires **Node >= 18** (uses global `fetch`/streams APIs in the code port, and
the VPS runs it optimally on 18+). Streams are I/O-bound, so Node 18/20 is fine.

```bash
# 1) Install Node (Debian/Ubuntu)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2) Install PM2 and Nginx
sudo npm i -g pm2
sudo apt-get install -y nginx

# 3) Get the proxy code onto the VPS (example: from the repo)
cd /opt && sudo git clone https://github.com/samirk2000/SwiftstvWeb.git swiftstv
cd /opt/swiftstv/vps-proxy && sudo npm install
#   (or rsync just /opt/swiftstv/vps-proxy on a plain VPS)

# 4) Start under PM2
pm2 start ecosystem.config.js
pm2 save
#   Run `pm2 startup` and paste the command it prints (autostart on reboot).
#   Check: `pm2 status` and `pm2 logs swift-stream-proxy`.

# 5) Smoke test locally
curl -s http://127.0.0.1:3000/healthz          # {"ok":true,...}
curl -s "http://127.0.0.1:3000/stream?target=<urlencoded m3u8>" -o /dev/null -w "%{http_code}\n"
```

## Nginx + Certbot

```bash
# 6) Point a DNS A record (e.g. proxy.swiftstv.com) at the VPS IP, then:
sudo cp /opt/swiftstv/vps-proxy/nginx.conf /etc/nginx/sites-available/proxy.swiftstv.com
#   — edit the file FIRST to match your real server_name (proxy.swiftstv.com).
sudo ln -s /etc/nginx/sites-available/proxy.swiftstv.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# 7) Free TLS + auto-renew:
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d proxy.swiftstv.com
# Certbot rewrites the server block with its own TLS config + redirect.
# Auto-renew: `sudo systemctl status certbot.timer` (enabled by default).
```

Firewall: allow 80/443 (e.g. `sudo ufw allow OpenSSH && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw enable`).

## Point the web app at it

On the **Cloudflare Pages** project, set a build env var and redeploy:

```
VITE_STREAM_PROXY_URLS=https://proxy.swiftstv.com/stream,https://swiftstv-web.vercel.app/api/stream-proxy
```

The player tries each proxy in order (your VPS first), then direct, then the
Pages `/proxy`. Your Hetzner VPS is not in Cloudflare's/AWS's ranges, so panels
that 403 those clouds will now stream.

## Proxy behaviour notes

- `UPSTREAM_TIMEOUT_MS` (ecosystem env, default `0`) aborts a hung upstream.
- Rate/size: Expression has no body limit by default, so huge VOD files pass.
- Nginx MUST have `proxy_buffering off` for large streaming (already set).
- To run a second proxy (different port/domain), duplicate the app in
  `ecosystem.config.js` with another `PORT` and add a matching Nginx `location`.

## Short cache for player_api lists (Nov 2026)

`proxy.js` keeps an in-memory cache (gzip-compressed) for these actions only:
`get_live_categories`, `get_vod_categories`, `get_series_categories`,
`get_live_streams`, `get_vod_streams`, `get_series`.

- TTL `LIST_CACHE_TTL_MS` (default 180000 = 3 min), size cap
  `LIST_CACHE_MAX_BYTES` (default 100 MB of gzip data, LRU eviction).
- Key = panel host + username + sha256(password) + action + category_id.
- Never cached: `get_user_info`/auth (no action), EPG, `get_*_info`, streams,
  any non-200 / non-JSON / `auth:0` response.
- Response header `X-Cache: HIT|MISS`; `/healthz` shows entries and bytes.
- Misses stream straight through (no waiting for the whole body).
- List calls ask the panel for `Accept-Encoding: gzip` (the VPS<->panel link
  is the slow part, ~60 KB/s); gzip is passed to gzip-capable clients as is.

> **Note:** the VPS actually runs an older proxy (from commit 78bd494, Aug 2026)
> plus the list cache. That exact file is `proxy.deployed.js`. `proxy.js`
> (continuous live fan-out, 45 s upstream timeout, etc.) has **not** been
> deployed to the VPS yet.

### VPS deployment state (2026-11-25)

- `/opt/swiftstv` on the VPS is a clone of this repo. Its local branch
  **`vps-deployed`** holds one commit with the running `vps-proxy/proxy.js`
  (= `proxy.deployed.js` here), so `git status` is clean. Backup files
  (`proxy.js.bak-*`, `proxy.js.v2-stream`) are ignored through
  `.git/info/exclude`. To update: edit, test on a side port
  (`PORT=3998 node proxy.js`), `pm2 reload swift-stream-proxy`, then commit
  on `vps-deployed`. Do not `git pull` main over it blindly.
- Live nginx site `proxy.swiftstv.com` has `proxy_read_timeout 300s`,
  `proxy_send_timeout 300s`, `send_timeout 300s`, `proxy_connect_timeout 15s`
  (slow panel lists used to hit nginx's default 60 s and return 504).
  Backups are in `/root/backups/`.
- Why `proxy.js` (live fan-out) is not deployed: it changes how live streams
  are delivered (one shared upstream per channel, a different teardown), and
  the VPS's only job is relaying HTTP to HTTPS for paying customers. The
  current stream path works, so that change needs its own planned test window.
