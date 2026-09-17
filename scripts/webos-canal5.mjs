import WebSocket from 'ws';
import fs from 'fs';

const CDP = 'http://127.0.0.1:9333';
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
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const ev = (expression, awaitPromise = false) =>
  send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true }).then((r) => {
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result?.value;
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.mkdirSync('tmp-webos', { recursive: true });
  fs.writeFileSync(`tmp-webos/${name}.png`, Buffer.from(r.data, 'base64'));
};

await send('Runtime.enable');
await send('Page.enable');

await ev(`location.href = '/live'`);
await sleep(2000);

await ev(
  `new Promise((res) => {
    const t0 = Date.now();
    const tick = () => {
      if (document.querySelector('input.search-box') && document.querySelectorAll('.channel').length > 0) res(true);
      else if (Date.now() - t0 > 60000) res(false);
      else setTimeout(tick, 300);
    };
    tick();
  })`,
  true
);

await ev(`(() => {
  const input = document.querySelector('input.search-box');
  const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  d.set.call(input, 'CANAL 5');
  input.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await sleep(1000);

const clicked = await ev(`(() => {
  const row = [...document.querySelectorAll('.channel')].find((el) =>
    /^CANAL 5\\b/i.test((el.querySelector('.channel-name')?.textContent || '').trim())
  );
  row?.click();
  return !!row;
})()`);

const play = await ev(
  `new Promise((res) => {
    const t0 = Date.now();
    const tick = () => {
      const v = document.querySelector('video');
      const href = location.href;
      const text = document.body.innerText.slice(0, 180);
      if (href.includes('/player') && v && v.readyState >= 2 && (v.currentTime > 0.2 || !v.paused)) {
        res({ ok: true, ready: v.readyState, t: v.currentTime, paused: v.paused, err: v.error && v.error.code });
      } else if (Date.now() - t0 > 70000) {
        res({ ok: false, href, ready: v && v.readyState, t: v && v.currentTime, paused: v && v.paused, err: v && v.error && v.error.code, text });
      } else setTimeout(tick, 500);
    };
    tick();
  })`,
  true
);

await shot('w-canal5');
console.log(JSON.stringify({ clicked, play }, null, 2));
ws.close();
