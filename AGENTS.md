# AGENTS.md — SwiftstvWeb (TV web app)

You are building **SwiftstvWeb**: a TV-first **web app** that replicates the Android port
(`SwiftstvAndroid`, in `C:\Users\samir\Downloads\SwiftstvAndroid`) and, ultimately, the Roku
channel (`MiRokuIPTV`). It must run in the built-in browser of Smart TVs: **LG (webOS),
Samsung (Tizen), Sony Bravia (Android TV / Google TV), and HISENSE (Vidaa)**.

Deploy target: **Cloudflare Pages** (static frontend + optional Pages Functions / Workers for
CORS-safe proxy calls).

## Source of truth (Android port + Roku)
Read these before implementing a feature:
- `C:\Users\samir\Downloads\SwiftstvAndroid` (Kotlin/Compose) — same logic, different UI.
- `C:\Users\samir\Downloads\MiRokuIPTV` — BrightScript original (`brand_config.brs`,
  `proxy_playback.brs`, `ExclusiveChannelsTask.brs`, `loginScene.brs`).

Key contracts to replicate:
- **Xtream API** (`player_api.php?username=..&password=..`), actions: `get_live_categories`,
  `get_live_streams`, `get_vod_categories`, `get_vod_streams`, `get_series`,
  `get_series_info`, `get_vod_info`, `get_short_epg`; streams at `{server}/live|movie|series/...`.
- **Multi-DNS login failover**: remote `servers.json` from
  `https://raw.githubusercontent.com/samirk2000/swiftstv-exclusivos/main/servers.json`
  (`{ "servers": [...], "cvc_aliases": [...] }`). Login races the CVC aliases first, then the
  remaining panels (Roku `buildLoginServerQueue`). Embedded defaults:
  `http://cvcplayer.us:8080`, `http://swiftstable.xyz:8080`. Falls back to embedded if remote 404s.
- **Exclusivos Swiftstv dynamic proxy**: remote config
  `https://raw.githubusercontent.com/samirk2000/swiftstv-exclusivos/main/exclusive_sources.json`
  (fallback `https://cdn.jsdelivr.net/gh/samirk2000/swiftstv-exclusivos@main/exclusive_sources.json`).
  Shape: `{ "proxy_base_url", "proxy_path", "proxy_headers": {referer, origin, user_agent}, "sources": [...] }`.
  A bare `sources`-only JSON must NOT wipe an already-published/local proxy config. Detection of
  what "needs origin headers" is dynamic against the published `proxy_base_url`/host/`proxy_path`,
  never hardcoded hosts.

## Rules
1. **Web TV first** (D-pad / remote navigation), touch secondary. Design for a 10-foot UI that
   also works on a phone browser.
2. **One codebase** (React + Vite) that runs in the TV browser and Cloudflare Pages.
3. Respect browser limits: use **HLS.js** / `<video>`/MediaSource for streams; account for
   per-platform codec gaps (AC3/EAC3 playback is limited in TV browsers); handle **CORS** — the
   Xtream panels and the Exclusivos proxy may not send CORS headers, so any credential/proxy call
   should go through a Cloudflare **Pages Function / Worker** (server-side) to avoid cross-origin blocks.
4. Drive/logic parity with Android for: Xtream login failover (`cvc_aliases`), live zapping +
   EPG + catchup, VOD, series (seasons/episodes), Exclusivos catalog + dynamic proxy header
   rules, continue watching, favorites, parental gate, i18n (es/en).
5. Small vertical slices that compile: **login → home → live → vod/series → player → Exclusivos**.
   Commit progress on branch `main`.
6. No secrets (real registered passwords) in source. Local debug only.

## MVP vertical slice (current goal)
Build a working React+Vite TV web app:
- [x] scaffold README (this repo)
- [x] Vite + React + routing + TV-first UI shell (focusable rows, remote nav)
- [x] Login screen (user/pass) + multi-DNS failover reading remote `servers.json` / `cvc_aliases`
- [x] Home (menu: Live, Movies, Series, Exclusivos), continue watching + favorites
- [x] Live guide (channels + EPG), catchup where panel provides archive
- [x] VOD grid + detail (search), Series with seasons/episodes (search)
- [x] Player: HLS.js integration, back buffer, audio/subs best-effort, PiP when supported
- [x] Exclusivos: remote catalog + dynamic proxy (via Pages Function for CORS)
- [x] Favorites (persisted, toggle + Home row)
- [x] Parental gate by PIN (blocked category_ids per saved profile; open by default)

## Build / run
`npm create vite@latest . -- --template react` (or manual), then `npm install`, `npm run dev`,
`npm run build`. Cloudflare Pages build command: `npm run build`; output dir `dist`.

## Support
- Email `soporte@swiftdigitalaccess.online` · WhatsApp `+52 662 268 4690`.
