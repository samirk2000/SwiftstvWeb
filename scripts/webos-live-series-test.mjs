import WebSocket from 'ws';
import fs from 'fs';

const CDP = process.env.WEBOS_CDP || 'http://127.0.0.1:9333';
const list = await (await fetch(`${CDP}/json/list`)).json();
const t = list.find((x) => /5173/.test(x.url));
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.mkdirSync('tmp-webos', { recursive: true });
  fs.writeFileSync(`tmp-webos/${name}.png`, Buffer.from(r.data, 'base64'));
};

await send('Page.enable');
await send('Runtime.enable');

await ev('location.assign("/live")');
await sleep(1500);
const liveLoaded = await ev(
  `new Promise((res) => {
    const t0 = Date.now();
    const tick = () => {
      const n = document.querySelectorAll('.channel').length;
      const input = document.querySelector('input.search-box');
      if ((n > 5 && input && !/Cargando/.test(document.body.innerText)) || Date.now() - t0 > 45000) {
        res({ n, href: location.href, hasInput: !!input });
      } else setTimeout(tick, 300);
    };
    tick();
  })`,
  true
);

const liveSearch = await ev(
  `(() => {
    const input = document.querySelector('input.search-box');
    if (!input) return { error: 'no-input' };
    const set = (el, v) => {
      const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      d.set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set(input, 'azteca');
    return new Promise((r) =>
      setTimeout(() => {
        r({
          count: document.querySelectorAll('.channel').length,
          names: [...document.querySelectorAll('.channel-name')].slice(0, 5).map((n) => n.textContent.trim()),
        });
      }, 900)
    );
  })()`,
  true
);
await shot('w-live-search');

await ev(`document.querySelector('.channel')?.click()`);
const livePlay = await ev(
  `new Promise((res) => {
    const t0 = Date.now();
    const tick = () => {
      const v = document.querySelector('video');
      if (location.pathname === '/player' && v && (v.readyState >= 2 || v.currentTime > 0)) {
        res({ ok: true, type: new URLSearchParams(location.search).get('type'), t: v.currentTime, paused: v.paused });
      } else if (Date.now() - t0 > 35000) {
        res({ ok: false, href: location.href, text: document.body.innerText.slice(0, 200) });
      } else setTimeout(tick, 400);
    };
    tick();
  })`,
  true
);
await shot('w-live-player');

await ev('location.assign("/series")');
await sleep(1200);
const seriesLoaded = await ev(
  `new Promise((res) => {
    const t0 = Date.now();
    const tick = () => {
      const n = document.querySelectorAll('.tile.poster').length;
      const input = document.querySelector('input.search-box');
      if ((n > 3 && input) || Date.now() - t0 > 45000) res({ n, hasInput: !!input });
      else setTimeout(tick, 300);
    };
    tick();
  })`,
  true
);
const seriesSearch = await ev(
  `(() => {
    const input = document.querySelector('input.search-box');
    if (!input) return { error: 'no-input' };
    const set = (el, v) => {
      const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      d.set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set(input, 'simpsons');
    return new Promise((r) =>
      setTimeout(() => {
        r({
          count: document.querySelectorAll('.tile.poster').length,
          titles: [...document.querySelectorAll('.tile.poster')].map((x) => x.textContent.trim()).slice(0, 5),
        });
      }, 900)
    );
  })()`,
  true
);
await shot('w-series-search');

console.log(JSON.stringify({ liveLoaded, liveSearch, livePlay, seriesLoaded, seriesSearch }, null, 2));
ws.close();
