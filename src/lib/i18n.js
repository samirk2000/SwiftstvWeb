// Lightweight i18n dictionary (es primary, en secondary). No external deps.
export const STRINGS = {
  es: {
    appName: 'Swiftstv',
    login: {
      username: 'Usuario',
      password: 'Contraseña',
      signIn: 'Iniciar Sesión',
      typeHint: 'Escribe tus credenciales',
      connecting: 'Conectando...',
      findingServer: 'Buscando el servidor más rápido...',
      tryingAlt: (n, t) => `Probando servidor alternativo (${n}/${t})...`,
      success: '¡Sesión iniciada!',
      empty: 'Ingresa usuario y contraseña',
      failed: 'No se pudo conectar a los servidores. Verifica tu internet o credenciales.',
      pressOkType: 'Presiona OK para escribir',
      languageHint: 'Idioma: Español (ES)',
      accountProblem: (title) => title,
    },
    home: {
      live: 'TV en vivo',
      movies: 'Películas',
      series: 'Series',
      exclusivos: 'Exclusivos',
      continueWatching: 'Seguir viendo',
      placeholder: 'Título',
    },
    live: {
      title: 'TV en vivo',
      now: 'AHORA',
      offAir: 'Sin programación',
      all: 'Todos',
    },
    vod: {
      title: 'Películas',
      search: 'Buscar...',
      noResults: 'Sin resultados',
      info: 'Información',
      play: 'Reproducir',
      quality: 'Calidad',
      duration: 'Duración',
    },
    series: {
      title: 'Series',
      seasons: 'Temporadas',
      episodes: 'Capítulos',
      info: 'Información',
    },
    player: {
      error: 'No se pudo reproducir este contenido.',
      back: 'Atrás',
    },
    exclusivos: {
      title: 'Canales Exclusivos',
      module: 'Exclusivos Swiftstv',
      noActive: 'No hay canales exclusivos disponibles para esta cuenta.',
      refresh: 'Actualizar catálogo',
      loading: 'Cargando catálogo...',
    },
    common: {
      back: 'Atrás',
      retry: 'Reintentar',
      loading: 'Cargando...',
      error: 'Algo salió mal',
    },
  },
  en: {
    appName: 'Swiftstv',
    login: {
      username: 'Username',
      password: 'Password',
      signIn: 'Sign In',
      typeHint: 'Enter your credentials',
      connecting: 'Connecting...',
      findingServer: 'Finding the fastest server...',
      tryingAlt: (n, t) => `Trying alternative server (${n}/${t})...`,
      success: 'Signed in!',
      empty: 'Enter username and password',
      failed: 'Could not connect to servers. Check your internet or credentials.',
      pressOkType: 'Press OK to type',
      languageHint: 'Language: English (EN)',
      accountProblem: (title) => title,
    },
    home: {
      live: 'Live TV',
      movies: 'Movies',
      series: 'Series',
      exclusivos: 'Exclusives',
      continueWatching: 'Continue watching',
      placeholder: 'Title',
    },
    live: {
      title: 'Live TV',
      now: 'NEXT',
      offAir: 'No program',
      all: 'All',
    },
    vod: {
      title: 'Movies',
      search: 'Search...',
      noResults: 'No results',
      info: 'Info',
      play: 'Play',
      quality: 'Quality',
      duration: 'Duration',
    },
    series: {
      title: 'Series',
      seasons: 'Seasons',
      episodes: 'Episodes',
      info: 'Info',
    },
    player: {
      error: 'Could not play this content.',
      back: 'Back',
    },
    exclusivos: {
      title: 'Exclusive Channels',
      module: 'Swiftstv Exclusives',
      noActive: 'No exclusive channels available for this account.',
      refresh: 'Refresh catalog',
      loading: 'Loading catalog...',
    },
    common: {
      back: 'Back',
      retry: 'Retry',
      loading: 'Loading...',
      error: 'Something went wrong',
    },
  },
};

let currentLang = 'es';

export function setLang(lang) {
  currentLang = lang === 'en' ? 'en' : 'es';
}

export function getLang() {
  return currentLang;
}

export function t(key, ...args) {
  const dict = STRINGS[currentLang] || STRINGS.es;
  const parts = key.split('.');
  let node = dict;
  for (const p of parts) {
    if (node && typeof node === 'object' && p in node) node = node[p];
    else return key;
  }
  if (typeof node === 'function') return node(...args);
  return typeof node === 'string' ? node : key;
}
