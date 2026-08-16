# SwiftstvWeb

**Swiftstv** — app web TV-first para Smart TVs (LG **webOS**, Samsung **Tizen**, Sony **Bravia / Android TV**, HISENSE **Vidaa**), replicando el port Android (`SwiftstvAndroid`) sobre **React + Vite**, desplegable en **Cloudflare Pages**.

## Qué es

Un cliente **Xtream** multiplataforma con **multi-DNS failover** de login y un módulo **Exclusivos Swiftstv** con proxy/origen de cabeceras dinámico leído desde GitHub. Se maneja con **D-pad / flechas del control + Enter** (10-foot UI) y también funciona en el navegador de un teléfono (responsive, claro → oscuro).

## Correr en local

```bash
npm install
npm run dev
```

Abre http://localhost:5173. El login describe usuario/contraseña (sin servidor fijo): prueba las DNS por sí solo.

Build / previsualización:

```bash
npm run build   # genera dist/
npm run preview
```

## Desplegar en Cloudflare Pages

- Build command: `npm run build`
- Output directory: `dist`
- `public/_redirects` da SPA fallback (`/*` → `/index.html`) para las rutas de react-router.
- `wrangler.toml` incluido (opcional) documenta Pages Functions como la vía futura de proxying CORS.

Ejemplo con wrangler:

```bash
npx wrangler pages deploy dist
```

## Estructura

```
index.html
vite.config.js
public/_redirects
wrangler.toml
src/
  main.jsx                    # entry
  App.jsx                     # router + sesión + shell + keys globales TV
  styles.css                  # tema oscuro TV-first, responsive
  lib/
    xtream.js                 # cliente Xtream (login, categorías, streams, info, EPG, playback, cache)
    dns.js                    # multi-DNS failover (servers.json remoto + aliases CVC, queue)
    exclusivos.js             # config/catálogo Exclusivos + tipos (hls/direct/m3u/json/extract) + proxy dinámico
    player.js                 # HLS.js/<video>, catchup, recovery, PiP, wake lock
    session.js                # localStorage (sesión, continuar viendo, favoritos, idioma)
    i18n.js                   # diccionario es/en (es por defecto)
    time.js, accountText.js   # helpers
  hooks/usePanelList.js       # carga reactiva de listas del panel
  components/Focusable.jsx    # foco espacial D-pad (sin dependencias)
  components/ui.jsx           # posters / tiles / filas
  context/SessionContext.jsx
  screens/                    # Login, Home, LiveGuide, VodGrid, VodDetail, SeriesList, SeriesDetail, Player, Exclusivos
```

## MVP cubierto

- Login con **multi-DNS failover** (CVC aliases se corren primero, luego los demás paneles) leyendo el `servers.json` remoto de GitHub con fallback embebido; sesión persistida en `localStorage` y restaurada al relanzar.
- Home (Live / Movies / Series / Exclusivos) + fila **seguir viendo**.
- Guía en vivo (canales + categorías), VOD (grid + detalle), Series (lista + detalle con temporadas/capítulos).
- Player con **HLS.js** (manifiesto, retry/recovery en stall DVR, posición de catchup), **PiP** y **Screen Wake Lock** best-effort.
- **Exclusivos**: catálogo remoto + parsing `hls/direct/m3u/json/extract`, y **proxy/origen dinámico** (Referer/Origin/User-Agent) detectado contra `proxy_base_url`/host/`proxy_path` publicados — sin dominios hardcodeados. Un JSON de solo canales no borra la config de proxy ya publicada.

## Stubs / best-effort en este MVP

- **EPG** por canal: en la guía se listan canales/categorías; la EPG corta y el catchup se preparan en `xtream.js` /`player.js`, pero el MVP prioriza una reproducción end-to-end antes que el pase de programación completo.
- **Favoritos**: utilidades en `session.js` listas; sin pantalla dedicada aún.
- **Gate parental**: previsto como stub futuro.
- **Voz a texto / teclado OS** en login: los campos son `<input>` nativos para el teclado remoto del TV (compatible webOS/Tizen); sin diálogo custom.

## Notas de CORS / codecs de navegador (Tizen / webOS / Vidaa)

- **CORS**: los paneles Xtream y el proxy Exclusivos pueden **no** mandar cabeceras CORS. En este MVP estático el navegador del TV/intérnate llama directo; algunos paneles podrían bloquear (CORS) ciertas peticiones. Aceptado por ahora — ver el comentario CORS en `src/lib/player.js`. El camino correcto a futuro es un **Pages Function / Worker** que proxée (documentado en `wrangler.toml`).
- **Codecs**: webOS/Tizen/Vidaa varían en soporte de **AC3/EAC3** y de ciertos subtítulos; hls.js degrada pero emitir A/HE-AAC/AC3 podría quedar sin audio en algunos dispositivos. Best-effort.
- **HLS.js**: `enableWorker:false` (sin Worker es más seguro en webviews de TV), `backBufferLength`, `LiveSyncDurationCount` y recovery de manifest en stalls DVR.
- Algunos modelos Tizen esperan playlists con resolución param; lo dejamos neutro (el manifest entregado manda).

## Soporte

- Email `soporte@swiftdigitalaccess.online` · WhatsApp `+52 662 268 4690`.
