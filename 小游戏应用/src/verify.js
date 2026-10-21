/*
 * verify.js — 构建产物离线验证器
 * ---------------------------------------------------------------
 * 用法: node src/verify.js <game-id> [--platform wechat]
 *
 * 验证四件事（无需真机 / 无需开发者工具）：
 *   1. 语法有效性：产物 game.js 能否被解析
 *   2. 运行时自举：在 Node 中注入最小宿主桩，验证适配层能否完成初始化
 *   3. 能力探测正确性：模拟四平台环境，断言 WebAudio 探测结果符合预期
 *   4. DOM 解析与布局：验证虚拟 DOM 树构建、样式表解析、盒模型计算
 *
 * 第 2/3/4 项在 Node 里跑，用 vm 模块 + 手写宿主桩模拟小游戏运行时。
 * 这不能替代真机测试，但能在提交前拦掉绝大多数结构性错误。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const REPO = path.resolve(ROOT, '..');
const RUNTIME_DIR = path.join(ROOT, 'runtime');
const DIST_DIR = path.join(ROOT, 'dist');

const NODE = process.execPath;
let pass = 0, fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { pass++; console.log(`    ✓ ${name}`); }
  else { fail++; failures.push({ name, detail }); console.log(`    ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

function section(t) { console.log(`\n  【${t}】`); }

/* ============ 宿主桩：模拟小游戏运行时 ============ */

/** 造一个可控的假 canvas 2D 上下文 */
function makeFakeCtx() {
  const calls = [];
  const rec = (n) => (...a) => { calls.push(n); };
  const grad = { addColorStop: rec('addColorStop') };
  return {
    calls,
    canvas: null,
    globalAlpha: 1, fillStyle: '', strokeStyle: '', font: '', lineWidth: 1,
    textBaseline: '', textAlign: '',
    save: rec('save'), restore: rec('restore'),
    translate: rec('translate'), scale: rec('scale'), rotate: rec('rotate'),
    setTransform: rec('setTransform'), resetTransform: rec('resetTransform'),
    beginPath: rec('beginPath'), closePath: rec('closePath'),
    moveTo: rec('moveTo'), lineTo: rec('lineTo'), arc: rec('arc'),
    arcTo: rec('arcTo'), rect: rec('rect'), roundRect: rec('roundRect'),
    fill: rec('fill'), stroke: rec('stroke'), clip: rec('clip'),
    fillRect: rec('fillRect'), strokeRect: rec('strokeRect'), clearRect: rec('clearRect'),
    fillText: rec('fillText'), strokeText: rec('strokeText'),
    drawImage: rec('drawImage'),
    measureText: (s) => ({ width: String(s).length * 8 }),
    createLinearGradient: () => grad,
    createRadialGradient: () => grad,
    createPattern: () => ({}),
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData: rec('putImageData'),
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    setLineDash: rec('setLineDash'), getLineDash: () => [],
    ellipse: rec('ellipse'), quadraticCurveTo: rec('quadraticCurveTo'),
    bezierCurveTo: rec('bezierCurveTo')
  };
}

function makeFakeCanvas() {
  const ctx = makeFakeCtx();
  return {
    width: 300, height: 150,
    getContext: () => ctx,
    _ctx: ctx,
    addEventListener() {}, removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 375, height: 667 })
  };
}

/**
 * 构造一个沙箱宿主。
 * @param {object} opts
 *   platform: 'wechat' | 'douyin' | 'alipay' | 'jd'
 *   webAudio: 是否提供 WebAudio 合成能力
 */
function makeSandbox(opts) {
  const { platform, webAudio } = opts;
  const store = {};
  const touchHandlers = {};
  const lifecycleHandlers = {};
  let canvasSeq = 0;

  const fakeAudioCtx = {
    state: 'running', currentTime: 0, sampleRate: 44100,
    destination: {},
    resume() {}, suspend() {},
    createOscillator: () => node(),
    createGain: () => node(),
    createBiquadFilter: () => node(),
    createBuffer: (ch, len) => ({ getChannelData: () => new Float32Array(len), length: len }),
    createBufferSource: () => node()
  };
  function node() {
    return {
      frequency: param(), gain: param(), type: '', buffer: null,
      connect() { return this; }, disconnect() {},
      start() {}, stop() {}
    };
  }
  function param() {
    return { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} };
  }

  const storageApi = {
    setStorageSync: (k, v) => { store[k] = v; },
    getStorageSync: (k) => (k in store ? store[k] : ''),
    removeStorageSync: (k) => { delete store[k]; },
    clearStorageSync: () => { for (const k in store) delete store[k]; }
  };

  function touchApi(on) {
    return {
      onTouchStart: (cb) => { touchHandlers.start = cb; },
      onTouchMove: (cb) => { touchHandlers.move = cb; },
      onTouchEnd: (cb) => { touchHandlers.end = cb; },
      onTouchCancel: (cb) => { touchHandlers.cancel = cb; },
      __fire: on
    };
  }

  const sysInfo = { windowWidth: 375, windowHeight: 667, pixelRatio: 3, safeArea: null };

  const base = {
    createCanvas: () => { canvasSeq++; return makeFakeCanvas(); },
    getSystemInfoSync: () => sysInfo,
    setStorageSync: storageApi.setStorageSync,
    getStorageSync: storageApi.getStorageSync,
    removeStorageSync: storageApi.removeStorageSync,
    clearStorageSync: storageApi.clearStorageSync,
    onTouchStart: (cb) => { touchHandlers.start = cb; },
    onTouchMove: (cb) => { touchHandlers.move = cb; },
    onTouchEnd: (cb) => { touchHandlers.end = cb; },
    onTouchCancel: (cb) => { touchHandlers.cancel = cb; },
    onShow: (cb) => { lifecycleHandlers.show = cb; },
    onHide: (cb) => { lifecycleHandlers.hide = cb; },
    onWindowResize: (cb) => { lifecycleHandlers.resize = cb; },
    vibrateShort: () => {}, setKeepScreenOn: () => {}
  };

  // 按平台装配命名空间
  const sandbox = {
    console: {
      log: (...a) => {}, warn: (...a) => {}, error: (...a) => { lastErrors.push(a.join(' ')); },
      info: () => {}
    },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON, Object, Array, String, Number, Boolean, Error, RegExp,
    isNaN, parseInt, parseFloat, Uint8ClampedArray, Float32Array, Uint8Array,
    Promise, Symbol, Map, Set, WeakMap, WeakSet,
    requestAnimationFrame: (cb) => { rafQueue.push(cb); return rafQueue.length; },
    cancelAnimationFrame: () => {},
    performance: { now: () => Date.now() },
    __store: store,
    __touchHandlers: touchHandlers,
    __lifecycleHandlers: lifecycleHandlers
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  const ns = { wechat: 'wx', douyin: 'tt', alipay: 'my', jd: 'jd' }[platform];
  const api = Object.assign({}, base);

  if (webAudio) {
    if (platform === 'douyin') api.getAudioContext = () => fakeAudioCtx;
    else api.createWebAudioContext = () => fakeAudioCtx;
  }
  // 支付宝：即使给了 createCanvasContext（旧式），也不给 WebAudio

  sandbox[ns] = api;
  sandbox.__ns = ns;
  sandbox.__api = api;
  // 必须经 createContext 才是合法的 vm 上下文
  return vm.createContext(sandbox);
}

let lastErrors = [];
let rafQueue = [];

/* ============ 验证项 ============ */

function loadRuntime(sandbox) {
  const order = [
    'mg-platform.js', 'mg-storage.js', 'mg-canvas.js', 'mg-audio.js',
    'mg-input.js', 'mg-ui-layout.js', 'mg-ui-render.js', 'mg-parser.js',
    'mg-dom.js', 'mg-lifecycle.js'
  ];
  order.forEach(f => {
    const code = fs.readFileSync(path.join(RUNTIME_DIR, f), 'utf8');
    vm.runInContext(code, sandbox, { filename: f });
  });
}
function verifySyntax(gameJsPath) {
  section('语法检查');
  const code = fs.readFileSync(gameJsPath, 'utf8');
  try {
    new vm.Script(code, { filename: gameJsPath });
    check('game.js 语法有效', true);
  } catch (e) {
    check('game.js 语法有效', false, e.message);
    return false;
  }
  // 附带检查：确认适配层 10 个模块都真实存在于产物中。
  // 【不采用花括号计数】——产物内嵌整段 CSS、游戏 HTML 骨架与大量正则字面量，
  // 朴素的 { } 统计无法区分代码结构与数据内容，会持续误报。
  // 语法有效性已由上一步 new vm.Script() 严格保证。
  const REQUIRED = [
    'mg-platform.js', 'mg-storage.js', 'mg-canvas.js', 'mg-audio.js',
    'mg-input.js', 'mg-ui-layout.js', 'mg-ui-render.js', 'mg-parser.js',
    'mg-dom.js', 'mg-lifecycle.js'
  ];
  const missing = REQUIRED.filter(f => !code.includes('runtime/' + f));
  check(`适配层模块齐全 (${REQUIRED.length} 个)`, missing.length === 0, '缺失: ' + missing.join(', '));

  check('游戏源码已注入（未丢失）', code.length > 10000, `产物仅 ${code.length} 字节`);
  return true;
}

function verifyRuntimeBoot(gameId, platform) {
  section(`运行时自举（${platform}）`);
  lastErrors = [];
  const gameJs = path.join(DIST_DIR, gameId, platform, 'game.js');
  if (!fs.existsSync(gameJs)) {
    check('产物存在', false, gameJs);
    return;
  }
  check('产物存在', true);

  // 按 config/platforms.json 的声明决定是否提供 WebAudio
  const platforms = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/platforms.json'), 'utf8'));
  const expectWebAudio = platforms.platforms[platform].capabilities.webAudio.supported === true;

  const sandbox = makeSandbox({ platform, webAudio: expectWebAudio });
  try {
    loadRuntime(sandbox);
    check('适配层 10 个模块加载无异常', true);
  } catch (e) {
    check('适配层 10 个模块加载无异常', false, e.message);
    return;
  }

  check('平台识别正确', sandbox.MGPlatform.id === platform,
    `期望 ${platform}，实际 ${sandbox.MGPlatform.id}`);

  check('WebAudio 探测结果符合平台声明',
    sandbox.MGPlatform.caps.webAudio === expectWebAudio,
    `期望 ${expectWebAudio}，实际 ${sandbox.MGPlatform.caps.webAudio}`);

  check('AudioContext 全局可构造（不抛错）', (() => {
    try { new sandbox.AudioContext(); return true; } catch (e) { return false; }
  })());

  check('localStorage 可读写', (() => {
    try {
      sandbox.localStorage.setItem('k', '123');
      return sandbox.localStorage.getItem('k') === '123';
    } catch (e) { return false; }
  })());

  check('store 穿透到平台存储', sandbox.__store && sandbox.__store.k === '123');

  check('globalThis.document 已注入', !!sandbox.document);
  check('globalThis.window 已注入', !!sandbox.window);
  check('screen 尺寸正确 (375x667)', (() => {
    const s = sandbox.MGPlatform.getScreen();
    return s.width === 375 && s.height === 667;
  })());

  // 执行完整产物
  try {
    vm.runInContext(fs.readFileSync(gameJs, 'utf8'), sandbox, { filename: 'game.js' });
    check('产物执行无异常', true);
  } catch (e) {
    check('产物执行无异常', false, e.message + '\n' + (e.stack || '').split('\n').slice(1, 4).join('\n'));
    return;
  }

  check('执行期无 console.error', lastErrors.length === 0, lastErrors.slice(0, 2).join(' | '));
  check('虚拟 DOM 已挂载（body 子节点 > 0）', (() => {
    const root = sandbox.document._root();
    return root && root.childNodes.length > 0;
  })());

  // 布局：跑一次排版，确认盒模型可算
  check('布局引擎可完成排版', (() => {
    try {
      sandbox.MGUI.invalidate();
      const root = sandbox.document._root();
      return !!root._box;
    } catch (e) { return false; }
  })());

  // UI 渲染：确认能画出内容（fillRect/fillText 被调用）
  check('UI 渲染产生绘制指令', (() => {
    try {
      const canvas = sandbox.MGCanvas.getMain();
      if (!canvas) return false;
      const ctx = canvas.getContext('2d');
      const before = ctx.calls.length;
      sandbox.MGUI.render(ctx);
      return ctx.calls.length > before;
    } catch (e) { return false; }
  })());

  // 输入：模拟触摸，验证事件扇出
  check('触摸事件正确扇出为 pointer/mouse/touch', (() => {
    try {
      const seen = [];
      sandbox.MGInput.addEventListener('canvas', 'pointerdown', () => seen.push('pointer'));
      sandbox.MGInput.addEventListener('canvas', 'touchstart', () => seen.push('touch'));
      sandbox.MGInput.addEventListener('canvas', 'mousedown', () => seen.push('mouse'));
      const h = sandbox.__touchHandlers;
      if (!h || !h.start) return false;
      h.start({ touches: [{ clientX: 100, clientY: 200, identifier: 0 }] });
      return seen.includes('pointer') && seen.includes('touch') && seen.includes('mouse');
    } catch (e) { return false; }
  })());
}

function verifyDomParsing() {
  section('DOM / CSS 解析');
  lastErrors = [];
  const sandbox = makeSandbox({ platform: 'wechat', webAudio: true });
  loadRuntime(sandbox);

  const html = `<div id="wrap" class="box">
    <div class="row"><span class="label" id="lbl">分数</span><big id="score">0</big></div>
    <div class="btn primary" id="start">开始 ▶</div>
  </div>`;

  const root = sandbox.MGParser.parseBody(html);
  // 一次性挂载完整样式表（含 .hidden 显隐规则），不中途替换——
  // 中途 setSheet 会丢弃原有规则，导致级联结果失真
  sandbox.MGUI.mount(html, `
    :root { --ink:#333333; --brand:#ffd23f; }
    .box { display:flex; flex-direction:column; padding:20px; background:#ffffff; }
    .row { display:flex; justify-content:space-between; align-items:center; height:40px; }
    .label { font-size:14px; color:var(--ink); }
    #score { font-size:28px; font-weight:bold; }
    .btn { border-radius:24px; padding:12px 24px; }
    .primary { background:#ffd23f; }
    .hidden { display:none; }
  `);

  check('解析出根节点', !!root);
  // HTML 中元素为 wrap / row / lbl / score / btn(primary) 共 5 个
  check('元素数量正确 (5)', countElements(root) === 5, `实际 ${countElements(root)}`);

  const byId = sandbox.document.getElementById;
  check('getElementById("wrap") 命中', !!byId('wrap'));
  check('getElementById("score") 命中', !!byId('score'));
  check('getElementById("start") 命中', !!byId('start'));
  check('getElementById 不存在返回 null', byId('nope') === null);

  const score = byId('score');
  check('初始 textContent 正确', score.textContent.trim() === '0', `实际 "${score.textContent}"`);

  // 核心机制：textContent 写入（游戏里 69 处）
  score.textContent = '999';
  check('textContent 写入生效', score.textContent.trim() === '999');
  check('写入后置脏标记', score._dirty === true);

  // 核心机制：classList（游戏里 108 处）
  const wrap = byId('wrap');
  wrap.classList.add('active');
  check('classList.add 生效', wrap.classList.contains('active'));
  wrap.classList.remove('active');
  check('classList.remove 生效', !wrap.classList.contains('active'));

  // 核心机制：classList 控制显隐（游戏里 58 处 .remove 依赖）
  wrap.classList.add('hidden');
  sandbox.MGUI.invalidate();
  const hiddenStyle = wrap._style && wrap._style.display;
  check('classList 控制 display:none', hiddenStyle === 'none', `实际 display=${hiddenStyle}`);
  check('display:none 时不再生成 box', (() => {
    // 布局时应跳过该节点子树
    return wrap._box === null || wrap._box === undefined;
  })(), `实际 _box=${JSON.stringify(wrap._box)}`);

  wrap.classList.remove('hidden');
  sandbox.MGUI.invalidate();
  check('移除 hidden 后恢复显示', wrap._style.display === 'flex',
    `实际 display=${wrap._style.display}`);

  // 布局数值
  sandbox.MGUI.invalidate();
  const lbl = byId('lbl');
  check('子元素完成布局（有 box）', !!lbl._box, JSON.stringify(lbl._box));
  if (lbl._box) {
    check('盒模型尺寸为正数', lbl._box.w > 0 && lbl._box.h > 0, JSON.stringify(lbl._box));
    check('元素在视口内', lbl._box.x >= 0 && lbl._box.x < 375);
  }

  // CSS 解析：变量与颜色
  const L = sandbox.MGLayout;
  check('parseColor #rgb', !!L.parseColor('#fff'));
  check('parseColor rgba', (() => { const c = L.parseColor('rgba(1,2,3,0.5)'); return c && c.r === 1 && c.a === 0.5; })());
  check('parseLength %', L.parseLength('50%', 200, 375, 667) === 100);
  check('parseLength px', L.parseLength('24px', 200, 375, 667) === 24);
  check('parseLength vw', Math.abs(L.parseLength('50vw', 200, 375, 667) - 187.5) < 0.01);

  // CSS 变量解析
  const sheet = sandbox.MGParser.parseCss(':root{--ink:#112233;} .a{color:var(--ink);}');
  check('CSS 变量 var() 正确解引用',
    sheet.rules.some(r => r.selector === '.a' && r.declarations.color === '#112233'));
}

function countElements(node) {
  let n = 0;
  (function walk(x) {
    (x.childNodes || []).forEach(c => {
      if (c.nodeType === 1) { n++; walk(c); }
    });
  })(node);
  return n;
}

/* ============ 主流程 ============ */

function main() {
  const argv = process.argv.slice(2);
  const gameId = argv.find(a => !a.startsWith('-'));
  const pIdx = argv.indexOf('--platform');
  const platform = (pIdx >= 0 && argv[pIdx + 1]) || 'wechat';

  if (!gameId) {
    console.log('用法: node src/verify.js <game-id> [--platform wechat|douyin|alipay|jd]');
    process.exit(1);
  }

  console.log(`\n═══ 验证 ${gameId} / ${platform} ═══`);

  const gameJs = path.join(DIST_DIR, gameId, platform, 'game.js');
  if (!fs.existsSync(gameJs)) {
    console.log(`\n产物不存在，请先构建:\n  node src/build.js ${gameId} --platform ${platform}\n`);
    process.exit(1);
  }

  verifySyntax(gameJs);
  verifyRuntimeBoot(gameId, platform);
  if (platform === 'wechat') verifyDomParsing();

  console.log(`\n═══ 结果: ${pass} 通过 / ${fail} 失败 ═══`);
  if (fail) {
    console.log('\n失败项:');
    failures.forEach(f => console.log(`  ✗ ${f.name}${f.detail ? '\n      ' + f.detail : ''}`));
    process.exit(1);
  }
  console.log('提示: 本验证在 Node 沙盒中进行，覆盖结构性问题。');
  console.log('真机表现仍需在对应平台开发者工具中确认。\n');
}

if (require.main === module) main();
