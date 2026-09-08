/**
 * tools/smoke-start.js — 启动冒烟测试
 * ---------------------------------------------------------------
 * 目的：防止「点击开始无响应」这类回归再次发生。
 * 做法：用桩 DOM/Canvas 在 Node 里真实执行每个游戏的 <script>，
 *       再触发所有 click / keydown 监听，捕获任何异常。
 *
 * 用法：node tools/smoke-start.js [游戏相对路径...]
 *   例：node tools/smoke-start.js                    # 跑全部
 *       node tools/smoke-start.js rabbit-racing/rabbit-racing-game.html
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// 默认扫描：各子目录里的 *-game.html + mixed-mode.html
function defaultTargets() {
  const out = [];
  for (const d of fs.readdirSync(ROOT)) {
    const dp = path.join(ROOT, d);
    if (!fs.statSync(dp).isDirectory() || d === 'tools' || d === 'node_modules') continue;
    for (const f of fs.readdirSync(dp)) {
      if (/-game\.html$/.test(f) || f === 'mixed-mode.html') out.push(path.join(d, f));
    }
  }
  return out.sort();
}

const targets = process.argv.slice(2).length ? process.argv.slice(2) : defaultTargets();

/* ---------------- 桩 ---------------- */
function makeCtx() {
  const base = {
    canvas: { width: 1200, height: 800 },
    fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1,
    font: '', textAlign: '', textBaseline: '', imageSmoothingEnabled: false,
    measureText: () => ({ width: 10 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    createPattern: () => ({}),
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)) }),
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)) })
  };
  return new Proxy(base, {
    get(t, p) {
      if (p in t) return t[p];
      return function () { return undefined; };   // 其余绘制指令一律 no-op
    },
    set(t, p, v) { t[p] = v; return true; }
  });
}

function makeEl(id, shared) {
  const cls = new Set();
  const listeners = {};
  const el = {
    id, tagName: 'DIV', value: '', href: '', dataset: {},
    // style 需支持 CSSStyleDeclaration 的方法（mixed-mode 用到 setProperty）
    style: (function () {
      const s = {};
      s.setProperty = (k, v) => { s[k] = v; };
      s.getPropertyValue = k => (s[k] === undefined ? '' : s[k]);
      s.removeProperty = k => { delete s[k]; };
      return s;
    })(),
    textContent: '', innerHTML: '', value: '', href: '',
    width: 1200, height: 800, children: [], checked: false,
    classList: {
      add(...c) { c.forEach(x => cls.add(x)); },
      remove(...c) { c.forEach(x => cls.delete(x)); },
      contains: c => cls.has(c),
      toggle(c, f) { const on = f === undefined ? !cls.has(c) : !!f; on ? cls.add(c) : cls.delete(c); return on; }
    },
    _cls: cls, _listeners: listeners,
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { return c; },
    insertBefore(c) { return c; },
    setAttribute() {}, removeAttribute() {}, getAttribute: () => null,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800, right: 1200, bottom: 800 }),
    getContext: () => shared.ctx,
    focus() {}, blur() {}, click() {}, remove() {},
    querySelector: () => null, querySelectorAll: () => [],
    set className(v) { cls.clear(); String(v).split(/\s+/).filter(Boolean).forEach(c => cls.add(c)); },
    get className() { return [...cls].join(' '); }
  };
  return el;
}

/* ---------------- 桩：Web Audio（可用版，用于验证正常路径） ----------------
   用 Proxy 兜底：任意 create* 节点、任意 AudioParam 都返回可用对象，
   避免「桩能力不足」被误报成游戏 bug。 */
const fakeParam = () => ({
  value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {},
  linearRampToValueAtTime() {}, setTargetAtTime() {}, cancelScheduledValues() {},
  setValueCurveAtTime() {}
});
function genericNode() {
  const base = {
    // 真实 WebAudio 的 connect() 返回目标节点，支持 o.connect(g).connect(dest) 链式写法
    connect(dst) { return dst || genericNode(); },
    disconnect() {}, start() {}, stop() {}
  };
  return new Proxy(base, {
    get(t, p) { return (p in t) ? t[p] : fakeParam(); },
    set(t, p, v) { t[p] = v; return true; }
  });
}
function makeFakeAC() {
  const ac = {
    state: 'running', currentTime: 0, sampleRate: 44100, destination: {},
    resume() { this.state = 'running'; return Promise.resolve(); },
    suspend() { return Promise.resolve(); },
    close() { return Promise.resolve(); },
    createBuffer: (ch, len) => ({
      getChannelData: () => new Float32Array(Math.max(1, len)), length: Math.max(1, len)
    }),
    createPeriodicWave: () => ({})
  };
  return new Proxy(ac, {
    get(t, p) {
      if (p in t) return t[p];
      if (typeof p === 'string' && p.indexOf('create') === 0) return () => genericNode();
      return undefined;
    }
  });
}
function FakeAC() { return makeFakeAC(); }

function runOne(relPath) {
  const file = path.join(ROOT, relPath);
  const html = fs.readFileSync(file, 'utf8');
  const shared = { ctx: makeCtx() };
  const els = {};
  const errors = [];

  const docListeners = {};
  const document = {
    getElementById(id) { return (els[id] = els[id] || makeEl(id, shared)); },
    createElement(tag) { const e = makeEl('new-' + tag, shared); e.tagName = String(tag).toUpperCase(); return e; },
    addEventListener(t, fn) { (docListeners[t] = docListeners[t] || []).push(fn); },
    removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
    documentElement: makeEl('html', shared),
    body: makeEl('body', shared),
    hidden: false, fullscreenElement: null, webkitFullscreenElement: null
  };

  let rafQ = [];
  const store = {};
  const win = {
    document,
    devicePixelRatio: 2, innerWidth: 1200, innerHeight: 800,
    addEventListener(t, fn) { (docListeners[t] = docListeners[t] || []).push(fn); },
    removeEventListener() {},
    requestAnimationFrame(fn) { rafQ.push(fn); return rafQ.length; },
    cancelAnimationFrame() {},
    performance: { now: () => Date.now() },
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; }
    },
    navigator: { maxTouchPoints: 0, userAgent: 'node' },
    location: { href: '', reload() {}, search: '' },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    alert() {}, confirm: () => true,
    AudioContext: FakeAC, webkitAudioContext: FakeAC,
    Math, Date, JSON, console, isNaN, parseInt, parseFloat, isFinite, encodeURIComponent, decodeURIComponent,
    Map, Set, Array, Object, String, Number, Boolean, Error, RegExp, Promise, Uint8ClampedArray, Float32Array
  };
  win.window = win;
  win.self = win;
  win.globalThis = win;

  const sandbox = vm.createContext(win);

  // 1) 先跑外链 shared.js（若该游戏引用了）
  const ext = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map(m => m[1]);
  for (const src of ext) {
    const p = path.resolve(path.dirname(file), src);
    if (!fs.existsSync(p)) { errors.push('外链脚本缺失: ' + src); continue; }
    try {
      vm.runInContext(fs.readFileSync(p, 'utf8'), sandbox, { filename: src });
    } catch (e) { errors.push('外链 ' + src + ' 执行失败: ' + e.message); }
  }

  // 2) 再跑内联脚本
  const blocks = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  blocks.forEach((src, i) => {
    try { vm.runInContext(src, sandbox, { filename: relPath + '#inline' + i }); }
    catch (e) { errors.push('内联脚本#' + i + ' 初始化抛错: ' + e.message); }
  });

  // 3) 触发交互监听：元素级 click/pointer/touch + window 级 click/keydown
  const warns = [];
  function fire(label, list, evt) {
    for (const fn of list) {
      try { fn(evt); } catch (e) { errors.push(label + ' 抛错: ' + e.message); }
    }
  }
  const baseEvt = {
    preventDefault() {}, stopPropagation() {},
    clientX: 10, clientY: 10, target: null,
    touches: [{ clientX: 10, clientY: 10 }],
    changedTouches: [{ clientX: 10, clientY: 10 }]
  };

  let clickCount = 0;
  for (const id in els) {
    for (const type of ['click', 'pointerdown', 'mousedown', 'touchstart']) {
      const ls = els[id]._listeners[type] || [];
      if (type === 'click') clickCount += ls.length;
      fire('#' + id + ' (' + type + ')', ls, Object.assign({}, baseEvt, { type }));
    }
    // .onclick 属性式绑定（多款游戏用这种写法，不能漏）
    for (const prop of ['onclick', 'onpointerdown', 'ontouchstart', 'onmousedown']) {
      if (typeof els[id][prop] === 'function') {
        if (prop === 'onclick') clickCount++;
        fire('#' + id + ' (' + prop + ')', [els[id][prop]], Object.assign({}, baseEvt, { type: 'click' }));
      }
    }
  }
  // window / document 级监听（游戏常把开始绑在这里）
  for (const type of ['click', 'pointerdown', 'keydown']) {
    const ls = docListeners[type] || [];
    const variants = (type === 'keydown') ? ['Enter', ' ', 'Space', 'ArrowLeft'] : [undefined];
    for (const k of variants) {
      fire('window.' + type + (k ? '(' + k + ')' : ''), ls,
        Object.assign({}, baseEvt, { type, key: k, code: k }));
    }
  }
  if (clickCount === 0) warns.push('未发现任何元素级 click 监听（开始可能只绑键盘/指针）');

  // 4) 跑 30 帧，捕捉首帧渲染期异常
  for (let f = 0; f < 30; f++) {
    const q = rafQ; rafQ = [];
    for (const fn of q) {
      try { fn(Date.now() + f * 16); }
      catch (e) { errors.push('第 ' + (f + 1) + ' 帧抛错: ' + e.message); f = 999; break; }
    }
  }

  return { relPath, errors, warns, hasShared: ext.length > 0 };
}

/* ---------------- 主流程 ---------------- */
let bad = 0;
console.log('启动冒烟测试 · 共 ' + targets.length + ' 款\n');
for (const t of targets) {
  const r = runOne(t);
  const ok = r.errors.length === 0;
  if (!ok) bad++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + t + (r.hasShared ? '  [shared.js]' : ''));
  r.errors.slice(0, 6).forEach(e => console.log('          ↳ ' + e));
  r.warns.forEach(w => console.log('          ⚠ ' + w));
}
console.log('\n结果: ' + (targets.length - bad) + ' 通过, ' + bad + ' 失败');
process.exit(bad ? 1 : 0);
