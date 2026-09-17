/**
 * Drive webOS TV 26 Simulator via Chromium CDP (remote-debugging-port).
 * Usage: node scripts/webos-cdp.mjs <cmd> [...args]
 */
import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';

const CDP_HOST = process.env.WEBOS_CDP || 'http://127.0.0.1:9333';
const OUT_DIR = path.resolve('tmp-webos');

async function listTargets() {
  const res = await fetch(`${CDP_HOST}/json/list`);
  return res.json();
}

function pickAppTarget(list) {
  return (
    list.find((t) => t.type === 'page' && /5173|pages\.dev|Swiftstv/i.test(t.url + t.title)) ||
    list.find((t) => t.type === 'page' && /login|vod|series|live/i.test(t.url))
  );
}

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
  }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression, awaitPromise = false) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.text || 'eval failed');
    }
    return r.result?.value;
  }
  async screenshot(name) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const r = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const file = path.join(OUT_DIR, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }
  /** Simulate LG remote key via CDP Input (raw key events). */
  async key(key, opts = {}) {
    const map = {
      ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
      ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
      ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
      ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
      Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
      Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
      Back: { key: 'GoBack', code: 'GoBack', windowsVirtualKeyCode: 461 },
      Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32 },
    };
    const m = map[key] || { key, code: key, windowsVirtualKeyCode: 0 };
    const base = {
      windowsVirtualKeyCode: m.windowsVirtualKeyCode,
      nativeVirtualKeyCode: m.windowsVirtualKeyCode,
      code: m.code,
      key: m.key,
      text: opts.text || '',
      unmodifiedText: opts.text || '',
      ...opts,
    };
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }
  close() {
    try {
      this.ws?.close();
    } catch {}
  }
}

async function withApp(fn) {
  const list = await listTargets();
  const target = pickAppTarget(list);
  if (!target) {
    console.error('No Swiftstv target. Targets:', list.map((t) => t.url));
    process.exit(2);
  }
  console.log('TARGET', target.title, target.url);
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  try {
    return await fn(cdp);
  } finally {
    cdp.close();
  }
}

const cmd = process.argv[2] || 'status';

if (cmd === 'status') {
  const list = await listTargets();
  console.log(JSON.stringify(list.map((t) => ({ title: t.title, url: t.url })), null, 2));
  process.exit(0);
}

if (cmd === 'shot') {
  await withApp(async (cdp) => {
    const name = process.argv[3] || 'shot';
    const file = await cdp.screenshot(name);
    const info = await cdp.eval(`({
      href: location.href,
      focus: (document.querySelector('[data-tv-focused="true"],.tv-focused')||{}).textContent?.trim?.()?.slice(0,80) || '',
      text: document.body.innerText.slice(0,400)
    })`);
    console.log(JSON.stringify({ file, info }, null, 2));
  });
  process.exit(0);
}

if (cmd === 'keys') {
  const keys = process.argv.slice(3);
  await withApp(async (cdp) => {
    for (const k of keys) {
      await cdp.key(k);
      await new Promise((r) => setTimeout(r, 250));
    }
    const info = await cdp.eval(`({
      href: location.href,
      focus: (document.querySelector('[data-tv-focused="true"],.tv-focused')||{}).textContent?.trim?.()?.slice(0,80) || '',
      flag: document.documentElement.dataset.tvPlayerKeys || ''
    })`);
    const file = await cdp.screenshot('after-keys');
    console.log(JSON.stringify({ keys, info, file }, null, 2));
  });
  process.exit(0);
}

if (cmd === 'eval') {
  const expr = process.argv[3];
  await withApp(async (cdp) => {
    const value = await cdp.eval(expr, true);
    console.log(JSON.stringify(value, null, 2));
  });
  process.exit(0);
}

if (cmd === 'login') {
  const user = process.argv[3] || '51370938';
  const pass = process.argv[4] || '51370938';
  await withApp(async (cdp) => {
    await cdp.eval(`(() => {
      const set = (el, v) => {
        const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        d.set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const u = document.querySelector('#login-user');
      const p = document.querySelector('#login-pass');
      if (u) set(u, ${JSON.stringify(user)});
      if (p) set(p, ${JSON.stringify(pass)});
      const btn = [...document.querySelectorAll('button')].find(b => /Iniciar|Sign/i.test(b.textContent||''));
      btn?.click();
      return { u: !!u, p: !!p, btn: !!btn };
    })()`);
    // wait home
    const ok = await cdp.eval(`new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        if (location.pathname === '/' || /Películas|TV en vivo|Movies/.test(document.body.innerText)) {
          resolve({ ok: true, href: location.href, text: document.body.innerText.slice(0, 300) });
          return;
        }
        if (Date.now() - t0 > 45000) {
          resolve({ ok: false, href: location.href, text: document.body.innerText.slice(0, 300) });
          return;
        }
        setTimeout(tick, 400);
      };
      tick();
    })`, true);
    const file = await cdp.screenshot('after-login');
    console.log(JSON.stringify({ ok, file }, null, 2));
  });
  process.exit(0);
}

if (cmd === 'navtest') {
  await withApp(async (cdp) => {
    const steps = [];
    const snap = async (label) => {
      const info = await cdp.eval(`({
        href: location.href,
        focus: (document.querySelector('[data-tv-focused="true"],.tv-focused')||{}).textContent?.trim?.()?.slice(0,80) || '',
        hasCyan: !!document.querySelector('.tv-focused,[data-tv-focused="true"]')
      })`);
      const file = await cdp.screenshot(label);
      steps.push({ label, ...info, file });
    };

    await snap('01-start');
    await cdp.key('ArrowRight');
    await new Promise((r) => setTimeout(r, 300));
    await snap('02-right');
    await cdp.key('ArrowRight');
    await new Promise((r) => setTimeout(r, 300));
    await snap('03-right2');
    await cdp.key('ArrowDown');
    await new Promise((r) => setTimeout(r, 300));
    await snap('04-down');
    await cdp.key('Enter');
    await new Promise((r) => setTimeout(r, 1200));
    await snap('05-enter');

    console.log(JSON.stringify(steps, null, 2));
  });
  process.exit(0);
}

console.error('Unknown cmd', cmd);
process.exit(1);
