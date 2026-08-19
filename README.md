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
- **Overlay "Cargando" robusto** (`Player.jsx`): el spinner se oculta al
  reproducir de verdad (evento `playing` **o** `currentTime >= 1s` en
  `timeupdate`), porque algunos navegadores/TV nunca emiten `playing` para MSE
  (hls.js/mpegts) y dejaban el spinner pegado sobre un video ya reproduciendo.

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
    saltos y el buffer natural queda acotado por el stash. El demux y el MSE
    corren en el **hilo principal** (`enableWorker:false` /
    `enableWorkerForMSE:false`): el worker dedicado de mpegts fallaba de forma
    silenciosa en algunos navegadores/TV (logs llenos de "Worker MediaSource
    attachment is closing" y **cero** peticiones `.ts` saliendo del reproductor,
    lo que forzaba el fallback HLS y abría conexiones segmentadas contra el
    panel); sin worker el `.ts` continuo se solicita y decodifica de forma
    fiable en todos los navegadores. Se mantienen `autoCleanupSourceBuffer: true`
    (limpia memoria sin reconectar) y `lazyLoad:false` /
    `deferLoadAfterSourceOpen:false`.
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
  el arranque como a mitad de reproducción; en **live** una pausa también cuenta
  como atasco porque el reproductor live no tiene botón de pausa — solo hay pausa
  intencional en VOD/archivo),
  hace teardown del reproductor mpegts (cierra la conexión continua) y conmuta
  automáticamente el mismo canal a su URL `.m3u8` (`tsToHlsUrl` → `attachHls`).
  La conmutación espera **3s** (`HLS_START_DELAY_MS`) para que el worker de
  mpegts termine de desprenderse del MediaSource y, sobre todo, para que el
  panel Xtream **libere la conexión continua del `.ts`**: si el `.m3u8` llega
  mientras el panel aún cuenta esa sesión, los segmentos bajan limitados
  (3.3MB en 8-10s) y hls.js nunca alcanza el borde en vivo (aborta el fragmento
  lento, recarga el playlist en bucle y no reproduce). El fallback HLS usa una
  **config de CDN lenta** (`maxBufferLength: 15` / `maxMaxBufferLength: 30`,
  `liveSyncDurationCount: 3`, `fragLoadingTimeOut: 60s`): los canales que caen aquí
  suelen servir sus
  segmentos desde una CDN que los baja casi a velocidad de reproducción, y la
  config normal abortaba el fragmento lento y recargaba el playlist en bucle →
  "Cargando" infinito aunque el panel mostrara la conexión. Como el arranque
  legítimo en CDN lenta puede tardar 30-50s en acumular buffer, el watchdog del
  fallback es por **fases**: a los **45s** sin avance hace **un reintento limpio**
  (destruye el Hls anterior, limpia el elemento y vuelve a adjuntar), y si tras
  otros **45s** sigue sin avanzar (contenido realmente no decodificable, p. ej.
  HEVC sin soporte) reporta el error real **con diagnóstico** (readyState,
  paused, currentTime, buffered ranges y `video.error`) para que la UI salga de
  "Cargando" infinito con pantalla de error/Reintentar.
  **Parche diferenciado (live HLS fallback = mono-conexión):** a diferencia de
  VOD, el fallback HLS en vivo NO prueba los 4 candidatos de proxy.
  `mediaCandidates(liveFallback)` devuelve **un único proxy** (el VPS `/stream`)
  y el config limita los reintentos (`fragLoadingMaxRetry: 3`,
  `manifestLoadingMaxRetry: 3`, `levelLoadingMaxRetry: 2`). Esto evita que un
  canal cuyo `.m3u8` el CDN sirve mal/404 se convierta en una **tormenta de
  peticiones** y en **múltiples conexiones simultáneas** al panel (el síntoma del
  canal 5: el panel mostrando ~3 conexiones y el network tab lleno). Un único
  reintento + el watchdog por fases + el botón "Reintentar" bastan; no se fuerza
  un bucle multi-proxy.
  **Parche diferenciado (live-edge alcanzable para canales HLS-only):** el canal
  5 (`95422`, "CANAL 5") sirve segmentos que bajan a **~0.6-0.9x la velocidad de
  reproducción** (un EXTINF de ~6-7s baja en ~9.3s vía proxy). Con `liveSyncDurationCount: 3`
  hls.js exige ~20s de buffer de margen que un canal a <1x jamás llena: decodifica
  el primer keyframe (se "ve" un frame) pero se queda **congelado en "Cargando"**
  recargando el playlist en bucle (→ muchas peticiones). Para los canales ya
  marcados **HLS-only** (memoria `hlsOnlyChannels`, donde mpegts no reproduce en
  ese navegador y el HLS es la ÚNICA vía), el fallback usa **`liveSyncCount: 1`**
  (un segmento de margen, ~7s) y buffer más corto (`maxBufferLength: 10`): se alcanza
  el borde en vivo aun a 0.7x, y el canal entra a reproducir aunque sea con buffer
  bajo. Los canales que caen al fallback por un fallo puntual (no HLS-only)
  conservan sync 3. Verificado en navegador: antes se congelaba en ~14s, ahora
  avanza de forma continua (30s, 47s… con `bufferedEnd` al día).
  Para depurar, `attachTs` registra en consola la ruta activa (`mpegts start` /
  `HLS fallback` / `fallback a HLS: <motivo>` / `reintento HLS #N`). El error
  solo se muestra si el fallback HLS también falla.
- **Memoria "HLS-only" por canal**: en algunos navegadores hay canales cuyo `.ts`
  continuo se descarga sin parar pero mpegts jamás produce reproducción, y la
  transición mpegts→HLS sobre el MISMO elemento puede dejar el MSE en un estado
  donde HLS descarga segmentos pero tampoco arranca. Para que no se repita el
  ciclo en cada zap: cuando un canal cae al fallback HLS por **no haber arrancado
  nunca** (memoria `swiftstv.hlsOnlyChannels.v1` en localStorage, clave
  `live:<id>`), el reproductor se **reinicia automáticamente con un `<video>`
  NUEVO** (`key={restart}`) e irá **directo a HLS** (`.m3u8`) la primera vez y en
  todos los zaps siguientes — sin esperar el watchdog del arranque
  (`MPEGTS_STALL_MS`=30s) ni arriesgar el
  elemento usado. La memoria se **auto-cura**: si el HLS directo también falla,
  se borra y un Reintentar vuelve a probar mpegts. Si el canal estaba
  reproduciendo y se trabó a mitad (no es un problema de arranque), NO se marca
  y el fallback en sitio se mantiene como antes. Adicionalmente, la memoria es
  **auto-limpiable en el sentido inverso**: si el canal reproduce por TS continuo
  (mpegts arranca y `currentTime` avanza), se borra el flag — así un canal que una
  vez cayó a HLS (por el bug de autoplay o un fallo puntual) vuelve al TS continuo
  en el siguiente zap y deja de abrir las múltiples conexiones del path HLS.
- **Menos conexiones al arrancar**: el path de **HLS fallback** es "ruidoso" para el
  panel — hls.js recarga el manifest `.m3u8` y baja segmentos de forma continua,
  y cada request al proxy se traduce en una conexión upstream al panel (el panel
  xui muestra 3+ conexiones y el network tab se llena). El **TS continuo (mpegts)**
  abre UNA sola conexión end-to-end. Dos ajustes refuerzan eso:
  1. `main.jsx` **no usa `<React.StrictMode>`**: en desarrollo React monta/desmonta/
     re-monta cada componente, disparando dos veces el efecto del Player y abriendo
     dos streams seguidos (la primera conexión tarda un instante en cerrarse en el
     proxy, así que el panel cuenta 2-3 "simultáneas"). Quitarlo reduce el arranque
     a una sola conexión (no afecta producción).
  2. Se limpia la memoria HLS-only en cuanto el TS reproduce (ver viñeta anterior).
- **Autoplay con sonido bloqueado**: los enlaces directos a `/player` (o
  navegadores con política estricta de autoplay) cargan datos pero dejan el
  video **pausado** (readyState alto, `currentTime` congelado → el watchdog lo
  trataría como canal muerto). `safePlay` detecta `NotAllowedError` y **reintenta
  en modo muted** (permitido en todas partes), mostrando un hint
  "Pulsa para activar el sonido" que desmuteará cuando el usuario pulse.
  En la ruta de **TS continuo (mpegts)** esto causaba el bug del canal 5 en Edge:
  mpegts descodifica el TS perfectamente pero su `play()` interno lanza
  `NotAllowedError` (autoplay bloqueado), el video nunca arranca y el watchdog de
  arranque lo marcaba "sin avance" y caía en **falso a HLS** (lento/frágil en ese
  canal) — de ahí "se ve pero no reproduce", restarts y conexiones extra en el
  panel. Ahora `startTs` captura esa excepción y **reintenta muted** (play nativo
  del elemento + re-arme del watchdog con margen completo), de modo que el canal
  arranca por TS continuo estable sin el ciclo de fallback. Para el arranque por
  autoplay, `MPEGTS_STALL_MS` pasó de 12s a **30s** (el setup del MSE tras el
  bloqueo puede tardar 15-25s); solo aplaza la detección de canales realmente
  rotos por TS — los que se congelan a mitad siguen siendo alcanzados por los
  watchdogs del fallback HLS y la liveness continua.
- **VOD / series / catchup / Exclusivos siguen en HLS**: el modo continuo se
  aplica solo a `type=live`. El catchup usa `start`/`end` (horario), por lo que
  el proxy lo trata como NO continuo.

## Soporte

- Email `soporte@swiftdigitalaccess.online` · WhatsApp `+52 662 268 4690`.
