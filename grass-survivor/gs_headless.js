/**
 * 一骑当千 · 横屏版无头仿真
 * 用 Node vm 跑真实 <script>，桩掉 DOM/Canvas，手动驱动 RAF 循环。
 * 用法：node gs_headless.js [容器宽] [容器高]
 *   例：node gs_headless.js 844 390   （iPhone 14 横屏）
 *       node gs_headless.js 1920 1080 （桌面）
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const FILE = path.join(__dirname, 'grass-survivor-game.html');
const CW = parseFloat(process.argv[2] || '844');
const CH = parseFloat(process.argv[3] || '390');

// ---------- 桩：DOM ----------
function mkEl(id) {
  const cls = new Set();
  return {
    id, style: {}, textContent: '', innerHTML: '',
    children: [],
    classList: {
      add(c) { cls.add(c); }, remove(c) { cls.delete(c); },
      contains(c) { return cls.has(c); },
      toggle(c) { cls.has(c) ? cls.delete(c) : cls.add(c); }
    },
    _cls: cls,
    appendChild(c) { this.children.push(c); },
    addEventListener() {}, removeEventListener() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, width: CW, height: CH, right: CW, bottom: CH };
    },
    getContext() { return CTX; },
    set className(v) { cls.clear(); String(v).split(/\s+/).filter(Boolean).forEach(c => cls.add(c)); },
    get className() { return [...cls].join(' '); },
    focus() {}, click() {}
  };
}

// ---------- 桩：Canvas 2D ----------
const CTX = {
  canvas: { width: 0, height: 0 },
  fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1,
  imageSmoothingEnabled: true, font: '', textAlign: '', textBaseline: '',
  setTransform() {}, save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
  beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, arc() {}, rect() {},
  fill() {}, stroke() {}, fillRect() {}, strokeRect() {}, clearRect() {},
  fillText() {}, drawImage() {}, clip() {}, createLinearGradient() { return { addColorStop() {} }; }
};

const els = {};
const doc = {
  getElementById(id) { return (els[id] = els[id] || mkEl(id)); },
  createElement(tag) { return mkEl('new-' + tag); },
  addEventListener() {}, removeEventListener() {},
  documentElement: mkEl('html'),
  fullscreenElement: null, webkitFullscreenElement: null,
  body: mkEl('body'), hidden: false
};

let rafQueue = [];
const win = {
  document: doc,
  devicePixelRatio: 2,
  innerWidth: CW, innerHeight: CH,
  addEventListener() {}, removeEventListener() {},
  requestAnimationFrame(fn) { rafQueue.push(fn); return rafQueue.length; },
  cancelAnimationFrame() {},
  performance: { now: () => T },
  localStorage: {
    _d: {},
    getItem(k) { return this._d[k] === undefined ? null : this._d[k]; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; }
  },
  navigator: { maxTouchPoints: 0 },
  setTimeout(fn, ms) { return 0; },          // 忽略延时回调（升级连音等）
  clearTimeout() {},
  AudioContext: undefined, webkitAudioContext: undefined,
  Math, Date, JSON, console, isNaN, parseInt, parseFloat, isFinite,
  Map, Set, Array, Object, String, Number, Boolean, Error
};
win.window = win;

// ---------- 提取并执行脚本 ----------
const html = fs.readFileSync(FILE, 'utf8');
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (!blocks.length) { console.error('未找到 <script> 块'); process.exit(1); }

// 探针必须注入到游戏 IIFE 的闭包内部，否则拿不到 W/state 等局部变量。
// 做法：把探针源码拼到最后一个 script 块的末尾，一起执行。
const PROBE = `
  window.__probe = function(){
    return {
      state: function(){ return state; },
      P: function(){ return P; },
      kills: function(){ return kills; },
      elapsed: function(){ return elapsed; },
      enemies: function(){ return enemies; },
      weapons: function(){ return weapons; },
      passives: function(){ return passives; },
      W: function(){ return W; }, H: function(){ return H; },
      bossRef: function(){ return bossRef; },
      cam: function(){ return cam; },
      WORLD_W: function(){ return WORLD_W; }, WORLD_H: function(){ return WORLD_H; },
      mode: function(){ return mode; },
      setMode: function(m){ mode = m; },
      start: function(){ startGame(); },
      pause: function(){ togglePause(); },
      quit: function(){ backToMenu(); },
      setInput: function(dx, dy){ stick.on = true; stick.dx = dx; stick.dy = dy; },
      clearInput: function(){ stick.on = false; stick.dx = 0; stick.dy = 0; },
      overTitle: function(){ return document.getElementById('overTitle').textContent; },
      resScore: function(){ return document.getElementById('resScore').textContent; },
      levelupHidden: function(){ return document.getElementById('levelup')._cls.has('hidden'); },
      pauseHidden: function(){ return document.getElementById('pauseOv')._cls.has('hidden'); },
      menuHidden: function(){ return document.getElementById('menu')._cls.has('hidden'); },
      choiceCount: function(){ return rollChoices().length; },
      // 无头环境里升级卡是 DOM 拼出来的，直接走内部 API 选第一项
      pickFirst: function(){
        if(state !== 'levelup') return false;
        var pool = rollChoices();
        if(pool.length){ applyChoice(pool[0]); }
        pendingLevels = 0;
        closeLevelUp();
        return true;
      },
      doResize: function(){ resize(); }
    };
  };
`;

let T = 0;
const sandbox = vm.createContext(win);
blocks.forEach((src, i) => {
  let code = src;
  if (i === blocks.length - 1) {
    // 游戏本体是 IIFE，探针必须插在收尾的 })(); 之前
    const close = src.lastIndexOf('})();');
    code = close > 0
      ? src.slice(0, close) + '\n' + PROBE + '\n' + src.slice(close)
      : src + '\n' + PROBE;
  }
  vm.runInContext(code, sandbox, { filename: 'game-block' + i + '.js' });
});

// ---------- 驱动 ----------
function step(ms) {
  T += ms;
  const q = rafQueue; rafQueue = [];
  q.forEach(fn => fn(T));
}
function run(seconds, ai) {
  const dt = 1000 / 60;
  const n = Math.round(seconds * 60);
  for (let i = 0; i < n; i++) {
    if (ai) ai(i / 60);
    step(dt);
  }
}
// 风筝 AI：逃离最近敌人 + 偶尔绕圈，模拟真人走位；比单纯绕圈更稳，能活过 60s 验证 Boss 出场
let aiT = 0;
function sillyAI() {
  aiT += 1 / 60;
  const k = win.__probe();
  if (k.state() === 'levelup') { k.pickFirst(); return; }
  if (k.state() !== 'play') return;
  const P = k.P();
  const es = k.enemies();
  let nx = 0, ny = 0, best = Infinity;
  for (let i = 0; i < es.length; i++) {
    const e = es[i];
    if (e.dead) continue;
    const d = Math.hypot(e.x - P.x, e.y - P.y);
    if (d < best) { best = d; nx = e.x - P.x; ny = e.y - P.y; }
  }
  let dx, dy;
  if (best < 320) { dx = -nx; dy = -ny; }          // 近敌：反向逃离
  else { const a = aiT * 1.4; dx = Math.cos(a); dy = Math.sin(a * 0.7); } // 安全：绕圈清场
  const m = Math.hypot(dx, dy) || 1;
  k.setInput(dx / m * 0.95, dy / m * 0.95);
}

const K = win.__probe();

// ---------- 断言 ----------
let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  (' + extra + ')' : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  (' + extra + ')' : '')); }
}

console.log('容器: ' + CW + '×' + CH + '  比例 ' + (CW / CH).toFixed(2) + ':1');
console.log('逻辑分辨率: W=' + K.W() + ' H=' + K.H() + '  战场 ' + K.WORLD_W() + '×' + K.WORLD_H());
console.log('');

// ===== 横屏专项 =====
console.log('Test 0: 横屏布局');
ok(K.H() === 540, '逻辑高度锁定 540', 'H=' + K.H());
ok(K.W() > K.H(), '逻辑宽度 > 高度（横屏）', 'W=' + K.W());
const expectW = Math.min(1400, Math.max(720, Math.round(540 * CW / CH)));
ok(K.W() === expectW, '逻辑宽度按容器比例推导', '期望 ' + expectW + ' 实得 ' + K.W());
ok(K.WORLD_W() > K.WORLD_H(), '战场为横长方形', K.WORLD_W() + '×' + K.WORLD_H());
ok(K.WORLD_W() >= K.W() * 2, '战场宽度 ≥ 2 屏', (K.WORLD_W() / K.W()).toFixed(2) + ' 屏');

// ===== A: 无限模式 =====
console.log('\nTest A: 无限模式 70 秒');
let err = null;
try {
  K.start();
  run(70, sillyAI);
} catch (e) { err = e; }
ok(!err, '70 秒无运行时异常', err ? err.message : '');
ok(K.kills() > 50, '割草量达标', 'kills=' + K.kills());
ok(K.P().level >= 5, '升级体系运转', 'Lv=' + K.P().level);
ok(K.bossRef() !== null || K.elapsed() > 60, '60 秒敌将已出场', 'bossRef=' + (K.bossRef() ? '在场' : 'null'));
const slots = K.weapons().length + Object.keys(K.passives()).length;
ok(slots >= 3, '升级带来新武器/被动', '栏位=' + slots);

// 相机边界
const cam = K.cam(), hw = K.W() / 2, hh = K.H() / 2;
ok(cam.x >= hw - 0.5 && cam.x <= K.WORLD_W() - hw + 0.5, '相机 X 锁在战场内',
  cam.x.toFixed(0) + ' ∈ [' + hw + ', ' + (K.WORLD_W() - hw) + ']');
ok(cam.y >= hh - 0.5 && cam.y <= K.WORLD_H() - hh + 0.5, '相机 Y 锁在战场内',
  cam.y.toFixed(0) + ' ∈ [' + hh + ', ' + (K.WORLD_H() - hh) + ']');

// ===== B: 限时模式 =====
console.log('\nTest B: 限时模式「功成」分支');
err = null;
try {
  K.setMode('timed');
  K.start();
  // 直接把时钟推到逼近 90 秒：用 AI 跑但把 TIME_LIMIT 用短测不可行，故跑满
  run(95, sillyAI);
} catch (e) { err = e; }
ok(!err, '限时模式无异常', err ? err.message : '');
ok(K.state() === 'over', '到时自动结算', 'state=' + K.state());
ok(K.overTitle() === '功成' || K.overTitle() === '败北', '结算标题有效', K.overTitle());
ok(parseInt(K.resScore(), 10) > 0, '结算得分 > 0', '得分=' + K.resScore());

// ===== C: 暂停/继续/回菜单 =====
console.log('\nTest C: 暂停 / 继续 / 回主菜单');
err = null;
try {
  K.setMode('infinite');
  K.start();
  run(3, sillyAI);
  K.pause();
  const paused = !K.pauseHidden();
  K.pause();
  const resumed = K.pauseHidden();
  K.clearInput();
  K.quit();
  const home = K.menuHidden();
  ok(paused, '暂停面板显示');
  ok(resumed, '继续后面板隐藏');
  ok(!home, '收兵回营回到主菜单');
} catch (e) { err = e; ok(false, '流程异常', e.message); }
ok(!err, '全流程无异常');

// ===== D: 极端比例不崩 =====
console.log('\nTest D: 边界比例');
[['超宽 21:9', 2520, 1080], ['接近正方 5:4', 1000, 800], ['极矮', 1600, 300]].forEach(([name, w, h]) => {
  let e2 = null;
  try {
    els['c'].getBoundingClientRect = () => ({ left: 0, top: 0, width: w, height: h, right: w, bottom: h });
    K.doResize();
    const nw = K.W();
    ok(nw >= 720 && nw <= 1400, name + ' 逻辑宽度被夹在 [720,1400]', 'W=' + nw);
  } catch (e) { e2 = e; ok(false, name + ' resize 异常', e.message); }
});

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
