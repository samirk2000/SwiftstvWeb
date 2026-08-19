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
- **HLS.js config**: `enableWorker: false` (sin fetches en workers paralelos),
  `lowLatencyMode: false`, `maxBufferLength: 10` / `maxMaxBufferLength: 15` /
  `maxBufferSize: 30MB` (buffer mínimo, reduce peticiones de chunks en paralelo),
  `liveSyncDurationCount: 3` / `liveMaxLatencyDurationCount: 5`, y
  `manifestLoadingTimeOut: 10000` / `manifestLoadingMaxRetry: 3` (reutiliza y
  ralentiza las peticiones de `.m3u8`). Los segmentos se descargan completos; la
  reducción de peticiones, sumada al keep-alive del proxy, evita ráfagas de
  conexiones HTTP hacia el panel.

## VOD que no arranca (contenedores y reintentos)

Algunos episodios/películas "funcionan en otras apps" pero no cargan aquí. Tres
causas y su mitigación:

- **Extensión que dispara transmux en vivo**: si el panel reporta
  `container_extension` `ts`/`m3u8`/`m3u` en una película, la URL `.ts` hace que
  el panel arranque una sesión de encode en vivo (lento, y la sesión se reajusta
  constantemente). `vodPlayableExtension` (`src/lib/xtream.js`) normaliza esos
  triggers a `.mp4` — el archivo almacenado se sirve igual sin importar la
  extensión — de modo que el VOD/serie llega como mp4 nativo y reproducible.
  Los `.mkv`/`.avi` se dejan intactos para que el fallback `mp4Variant` del
  player siga activo.
- **Contenedor no soportado por el navegador del TV** (`.mkv`, `.avi`, `.flv`,
  `.wmv`, …): las apps IPTV usan ExoPlayer/VLC que sí los demuxan; el `<video>`
  del navegador no. Swiftstv intenta la MISMA id como `.mp4` como candidato de
  cola (`mp4Variant`/`alternateUrls` en `src/lib/player.js`) — muchos paneles
  sirven el mismo archivo sin importar la extensión — y si aún falla muestra un
  mensaje claro de formato/códec (`player.formatError`) en vez de un spinner
  infinito.
- **Fallo transitorio del panel** (302/403/5xx puntual): un error duro provoca UN
  reintento cache-busted de la misma ruta (`MAX_NATIVE_RETRIES = 1`), estrictamente
  secuencial (`setNativeSrc` limpia el elemento antes de reasignar `src`, de modo
  que el panel nunca ve conexiones solapadas), y luego avanza al siguiente
  candidato. Nunca hay bucle automático; tras agotar rutas se muestra error con
  botón de reintento manual.
- **Arranque lento de CDN/panel**: el timeout de socket del upstream del proxy
  subió de 10s a `UPSTREAM_TIMEOUT_MS || 45000` (`vps-proxy/proxy.js`) para no
  matar archivos grandes que tardan en responder el primer byte.

## Arranque rápido del reproductor

El VOD arranca en cuanto el navegador tiene el primer frame decodificado:

- **Play en `canplay`/`loadedmetadata`** (`src/screens/Player.jsx`): además del
  `play()` inmediato, se vuelve a llamar `video.play()` al dispararse cualquiera
  de esos eventos, de modo que el `<video>` nativo reproduce en cuanto llegan los
  primeros KB sin esperar a llenar el buffer. Un rechazo con `AbortError` se
  ignora (significa que un reintento/candidato reemplazó la carga), no se trata
  como error.
- **Buffer de arranque mínimo en mpegts.js** (`attachTs`): stash de 512KB para
  live (arranque fluido y margen de estabilidad) y 128KB para VOD/archivo, y
  `lazyLoad: false` / `deferLoadAfterSourceOpen: false` para empezar en cuanto
  llegan los primeros bytes del `.ts` continuo.

## Live en MPEG-TS continuo (1 conexión por canal)

Para **live** el reproductor ya no usa HLS segmentado (`.m3u8` + `.ts`), que hace
que el panel cuente cada fragmento como una conexión nueva. En su lugar:

- **URL**: `{server}/live/{u}/{p}/{ID}.ts` (`liveStreamTsUrl` en `src/lib/xtream.js`),
  un MPEG-TS de flujo continuo.
- **Proxy (`vps-proxy/proxy.js`)**: la ruta `/stream` detecta el live `.ts`
  (o el flag `continuous=1`) y abre **una sola conexión origen por canal**
  (`LIVE_FANOUT`), haciéndole `.pipe(res)` a **todos** los espectadores del canal.
  Si otro usuario entra al mismo canal, **reutiliza el mismo upstream** sin abrir
  una segunda conexión al panel. Cuando el **último** espectador se desconecta,
  se cierra el upstream y se elimina la entrada (teardown-on-idle); un solo
  espectador que sale **nunca** mata el stream compartido.
- **Frontend (`src/lib/player.js#attachTs`)**: decodifica el `.ts` continuo con
  **mpegts.js** (`type: 'mpegts', cors: true`) sobre MSE. El config distingue
  **LIVE vs VOD** (`opts.isLive`):
  - **Live (`isLive:true`)** — baja latencia + mono-conexión estricta con
    **stash holgado**: `enableStashBuffer: true` con `stashInitialSize` de
    512KB para un arranque fluido, y **chasing de latencia DESACTIVADO**
    (`liveBufferLatencyChasing: false`): el chaser de mpegts.js hace un
    direct-seek en el `<video>` cada vez que el buffer adelantado supera el
    umbral; como el proxy entrega más rápido que el tiempo real, eso provocaba
    un trabo periódico cada ~10s. Sin chasing el video avanza continuo sin
    saltos y el buffer natural queda acotado por el stash. Se mantienen
    `autoCleanupSourceBuffer: true` (limpia memoria sin reconectar),
    `enableWorker:true` y `lazyLoad:false` / `deferLoadAfterSourceOpen:false`.
  - **VOD/archivo (`isLive:false`)** — `enableStashBuffer: true` con
    `stashInitialSize` de 128KB, sin chasing, para arranque rápido y estable.
- **Fallback a HLS**: si `mpegts.js` no está soportado (no hay MSE live), emite
  un **error fatal** al adjuntar/decodificar el TS (p. ej. error de MSE/decode),
  **o el video no avanza** — algunos canales se CONECTAN en el panel y descargan
  sin parar, pero mpegts no produce frames o renderiza un "slideshow" (solo
  llegan keyframes: la imagen cambia cada GOP ~10s mientras `currentTime` está
  congelado y `readyState` queda alto porque MSE sigue recibiendo datos, así que
  comprobar readyState no basta). Un **watchdog de liveness** (`livenessWatch`)
  muestrea `currentTime` cada 2s y, si no avanza ≥0.5s durante **12s** (tanto en
  el arranque como a mitad de reproducción; una pausa intencional no cuenta),
  hace teardown del reproductor mpegts (cierra la conexión continua) y conmuta
  automáticamente el mismo canal a su URL `.m3u8` (`tsToHlsUrl` → `attachHls`).
  La conmutación espera **2s** (`HLS_START_DELAY_MS`) para que el worker de
  mpegts termine de desprenderse del MediaSource y, sobre todo, para que el
  panel Xtream **libere la conexión continua del `.ts`**: si el `.m3u8` llega
  mientras el panel aún cuenta esa sesión, los segmentos bajan limitados
  (3.3MB en 8-10s) y hls.js nunca alcanza el borde en vivo (aborta el fragmento
  lento, recarga el playlist en bucle y no reproduce). El fallback HLS usa la
  **config tolerante pre-migración** (`maxBufferLength: 10`,
  `liveSyncDurationCount: 3`, `fragLoadingMaxRetry: 6`): la config estricta de
  mono-conexión (2 segmentos de sincronía, 3s de búfer) hacía que canales con
  segmentos grandes y CDN lenta nunca alcanzaran el borde vivo → HLS.js
  abortaba el fragmento lento y recargaba el playlist en bucle → "Cargando"
  infinito aunque el panel mostrara la conexión. Un **segundo watchdog de
  liveness** (60s) vigila ese fallback: si el HLS tampoco avanza (contenido
  realmente no decodificable, p. ej. HEVC sin soporte), se reporta el error real
  para que la UI salga de "Cargando" infinito con pantalla de error/Reintentar.
  Para depurar, `attachTs` registra en consola la ruta activa (`mpegts start` /
  `HLS fallback` / `fallback a HLS: <motivo>`). El error solo se muestra si el
  fallback HLS también falla.
- **VOD / series / catchup / Exclusivos siguen en HLS**: el modo continuo se
  aplica solo a `type=live`. El catchup usa `start`/`end` (horario), por lo que
  el proxy lo trata como NO continuo.

## Soporte

- Email `soporte@swiftdigitalaccess.online` · WhatsApp `+52 662 268 4690`.
