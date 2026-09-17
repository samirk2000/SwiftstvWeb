import WebSocket from 'ws';
import fs from 'fs';

const CDP = process.env.WEBOS_CDP || 'http://127.0.0.1:9333';
const list = await (await fetch(`${CDP}/json/list`)).json();
const t = list.find((x) => /5173/.test(x.url));
if (!t) {
  console.error('no target');
  process.exit(2);
}
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.once('open', r));
let id = 0;
const pending = new Map();
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(JSON.stringify(m.error)));
    else resolve(m.result);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const ev = (expression, awaitPromise = false) =>
  send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  }).then((r) => {
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result?.value;
  });
const key = async (name, vk) => {
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: name,
    code: name,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: name,
    code: name,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
  });
};
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.mkdirSync('tmp-webos', { recursive: true });
  fs.writeFileSync(`tmp-webos/${name}.png`, Buffer.from(r.data, 'base64'));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send('Page.enable');
await send('Runtime.enable');

const results = {};

await ev('location.assign("/")');
await sleep(1200);
await shot('w-home');

// Focus may be on Live; move to Películas
await key('ArrowRight', 39);
await sleep(250);
await key('Enter', 13);
await sleep(1500);
results.vodHref = await ev('location.href');
await shot('w-vod');

results.vodLoaded = await ev(
  `new Promise((res) => {
    const t0 = Date.now();
    const tick = () => {
      const n = document.querySelectorAll('.tile.poster').length;
      if (n > 5 || Date.now() - t0 > 45000) {
        res({ n, loading: /Cargando/.test(document.body.innerText) });
      } else setTimeout(tick, 300);
    };
    tick();
  })`,
  true
);

results.search = await ev(
  `(() => {
    const set = (el, v) => {
      const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      d.set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const input = document.querySelector('input.search-box');
    set(input, 'encanto');
    return new Promise((r) =>
      setTimeout(() => {
        r({
          count: document.querySelectorAll('.tile.poster').length,
          titles: [...document.querySelectorAll('.tile.poster')].slice(0, 6).map((x) => x.textContent.trim()),
          selected: [...document.querySelectorAll('.cat-chip.selected')].map((b) => b.textContent.trim()),
        });
      }, 1000)
    );
  })()`,
  true
);
await shot('w-vod-search');

await ev(`(() => {
  const tile = [...document.querySelectorAll('.tile.poster')].find((x) => /Encanto \\(2021\\)/.test(x.textContent));
  tile?.click();
  return !!tile;
})()`);

results.detail = await ev(
  `new Promise((res) => {
    const t0 = Date.now();
    const tick = () => {
      if (location.pathname.startsWith('/vod/') && /Reproducir/.test(document.body.innerText)) {
        res({ ok: true, href: location.href, text: document.body.innerText.slice(0, 250) });
      } else if (Date.now() - t0 > 20000) {
        res({ ok: false, href: location.href, text: document.body.innerText.slice(0, 250) });
      } else setTimeout(tick, 300);
    };
    tick();
  })`,
  true
);
await shot('w-vod-detail');

await ev(`([...document.querySelectorAll('button')].find((b) => /Reproducir/.test(b.textContent)) || {}).click?.()`);

results.player = await ev(
  `new Promise((res) => {
    const t0 = Date.now();
    const tick = () => {
      const v = document.querySelector('video');
      if (location.pathname === '/player' && v && v.readyState >= 2) {
        res({
          ok: true,
          paused: v.paused,
          t: v.currentTime,
          flag: document.documentElement.dataset.tvPlayerKeys || '',
          controls: !!document.querySelector('.player-controls'),
        });
      } else if (Date.now() - t0 > 40000) {
        res({ ok: false, href: location.href, text: document.body.innerText.slice(0, 200) });
      } else setTimeout(tick, 400);
    };
    tick();
  })`,
  true
);
await shot('w-player');

if (results.player?.ok) {
  await ev(`document.querySelector('.player-screen')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await sleep(350);
  const before = await ev(`({
    t: document.querySelector('video').currentTime,
    paused: document.querySelector('video').paused,
    controls: !!document.querySelector('.player-controls')
  })`);
  await key('ArrowDown', 40);
  await sleep(400);
  const afterDown = await ev(`({
    t: document.querySelector('video').currentTime,
    paused: document.querySelector('video').paused,
    controls: !!document.querySelector('.player-controls'),
    focusPause: !!document.querySelector('[data-player-pause].tv-focused, [data-player-pause][data-tv-focused]')
  })`);
  await key('Enter', 13);
  await sleep(450);
  const afterOk = await ev(`({
    paused: document.querySelector('video').paused,
    leave: !!document.querySelector('.player-leave')
  })`);
  await key('Enter', 13);
  await sleep(400);
  await key('ArrowRight', 39);
  await sleep(500);
  const afterRight = await ev(`({
    t: Math.round(document.querySelector('video').currentTime),
    paused: document.querySelector('video').paused
  })`);
  await key('Escape', 27);
  await sleep(400);
  const afterEsc = await ev(`({
    leave: !!document.querySelector('.player-leave'),
    focus: (document.querySelector('.tv-focused') || {}).textContent?.trim?.() || ''
  })`);
  results.transport = { before, afterDown, afterOk, afterRight, afterEsc };
  await shot('w-player-leave');
}

console.log(JSON.stringify(results, null, 2));
ws.close();
