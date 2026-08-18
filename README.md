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
- Home (Live / Movies / Series / Exclusivos / Control parental) + fila **seguir viendo** (botón "Resumir" que reanuda por posición) + fila **Favoritos**.
- Guía en vivo con canales/categorías + **catchup** (selector por canal con `get_short_epg`: elige un programa del archivo y se reproduce por `start`).
- VOD (grid + detalle), Series (lista + detalle con temporadas/capítulos), ambos con **búsqueda** en el cliente.
- **Favoritos** (toggle en detalle VOD/Series y en canales) persistidos en `localStorage`.
- Player con **HLS.js** (manifiesto, retry/recovery en stall DVR, posición de catchup), **PiP** y **Screen Wake Lock** best-effort.
- **Exclusivos**: catálogo remoto + parsing `hls/direct/m3u/json/extract`, y **proxy/origen dinámico** (Referer/Origin/User-Agent) detectado contra `proxy_base_url`/host/`proxy_path` publicados — sin dominios hardcodeados. Un JSON de solo canales no borra la config de proxy ya publicada.
- **Control parental por PIN**: restringe `category_ids` por perfil guardado en `localStorage`; por defecto todo pasa sin PIN (gate abierto). Admón. en `/parental`.

## Stubs / best-effort en este MVP

- **Catchup por fecha/hora**: el selector está en la guía por canal (lee `get_short_epg` y arma la URL de archivo con `start`). Depende de que el panel ofrezca el archivo; canales sin `tv_archive:1` no muestran el selector.
- **Favoritos**: utilidades en `session.js` + UI de toggle y fila en Home. Sin gestión de "eliminar desde Home", pero el toggle en detalle/canal la mantiene.
- **Gate parental**: administración básica (`/parental`): PIN + categorías bloqueadas por perfil; el bloqueo se aplica ocultando `category_ids` en las listas. Sin perfiles múltiples por usuario todavía — un solo perfil activo.
- **Voz a texto / teclado OS** en login: los campos son `<input>` nativos para el teclado remoto del TV (compatible webOS/Tizen); sin diálogo custom.

## Notas de CORS / codecs de navegador (Tizen / webOS / Vidaa)

- **CORS**: los paneles Xtream y el proxy Exclusivos pueden **no** mandar cabeceras CORS. En este MVP estático el navegador del TV/intérnate llama directo; algunos paneles podrían bloquear (CORS) ciertas peticiones. Aceptado por ahora — ver el comentario CORS en `src/lib/player.js`. El camino correcto a futuro es un **Pages Function / Worker** que proxée (documentado en `wrangler.toml`).
- **Codecs AC3/EAC3 (VOD y en vivo)** — probar en hardware, no asumas:
  - **LG webOS (WebKit)**: soporta AC3 en MP4/TTS por enmuxer nativo, pero **EAC3 puede sonar mudo** o requerir `.ac3`/`.eac3` envueltos en TS. hls.js degrada el audio pero el párametro del panel manda.
  - **Samsung Tizen (Chromium-WebKit)**: AC3 soportado de forma inconsistente entre años; **EAC3 (Dolby Digital Plus)** frecuentemente **sin audio** en cajas más viejas. La app los entrega tal cual; no transcodeamos.
  - **HISENSE Vidaa**: limitado; AC3 a 5.1 a menudo se colapsa a estéreo o silencio, y EAC3 puede no reproducirse. Best-effort.
  - **Sin transcodificación**: Swiftstv sólo reenvía los contenedores/programas originales del panel; si el panel entrega AC3/EAC3 y el TV lo rechaza, se espera la caída a estéreo/otro programa, no un downgrade automático. Esto se documenta para futura decisión (proxy con transcode a HE-AAC/aac).
- **HLS.js**: `enableWorker:false` (sin Worker es más seguro en webviews de TV), `backBufferLength`, `LiveSyncDurationCount` y recovery de manifest en stalls DVR.
- **Catchup DVR**: el reproductor salta a `startPosition` tras `loadedmetadata`; para canales con archivo el proxy sigue 302→CDN igual que el directo. Probar el rango `Range` en el `stream-proxy` para `seek` dentro del archive.
- Algunos modelos Tizen esperan playlists con resolución param; lo dejamos neutro (el manifest entregado manda).

## Gestión de conexiones hacia el panel (sin cortar el playback)

El panel limita streams simultáneos por cuenta. La estrategia evita ráfagas de
sockets, pero NUNCA cancela un segmento a medio descargar (eso corrompería el
buffer HLS con fragmentos incompletos y congelaría el reproductor):

- **Proxy (`vps-proxy/proxy.js`)**: NO se cancela la petición anterior por
  usuario/IP al llegar una nueva. Los fragmentos HLS concluyen de forma natural
  para no romper el buffer. Cuando el cliente se va (desconecta/error) se aborta
  la petición upstream correspondiente (`req.on('aborted')` / `res.on('close')`).
- **Keep-Alive de sockets reutilizados**: los `http.Agent`/`https.Agent`
  globales usan `keepAlive: true` + `maxSockets: 50`. Cada socket TCP del VPS
  hacia el panel/CDN queda abierto para reutilizarse en los siguientes request —
  así el panel no registra una desconexión/reconexión por cada `.ts`, sin
  serializar descargas (un `maxSockets` de 1 sí rompería el streaming).
- **Frontend (`Player.jsx`)**: `activeAbortController` single-flight. Aborta el
  fetch previo al arrancar un stream y limpia el `<video>` (`src=''` + `load()`)
  en `onError`/`pause`/desmontaje, soltando el socket hacia el proxy.
- **HLS.js config**: `enableWorker: true`, `lowLatencyMode: false`,
  `backBufferLength: 30`, y buffer mínimo (`maxBufferLength: 10`,
  `maxMaxBufferLength: 20`) para no lanzar peticiones de chunks en ráfagas
  paralelas descontroladas. Los segmentos se descargan completos; la reducción
  de peticiones, sumada al keep-alive, mantiene 1 conexión estable en el panel.

## Soporte

- Email `soporte@swiftdigitalaccess.online` · WhatsApp `+52 662 268 4690`.
