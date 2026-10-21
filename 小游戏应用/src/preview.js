/*
 * preview.js — 浏览器预览壳
 * ---------------------------------------------------------------
 * 用途：在桌面浏览器里加载构建产物，做「真渲染」验证。
 *
 * 为什么要单独做：
 *   src/verify.js 在 Node 沙盒里用假 canvas 上下文验证结构正确性，
 *   但无法证明「视觉上真的画出来了」。本预览壳把产物挂到真实 <canvas>，
 *   可用 Chrome 无头模式截图，人工/自动核对 UI 还原效果。
 *
 * 生成: node src/preview.js <game-id> [--platform wechat] [--out <file.html>]
 * 打开: 直接在浏览器打开生成的 html，或用 chrome --headless --screenshot 截图
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT, 'dist');

/** 生成一个自包含的预览页：内嵌 game.js，并提供宿主桩 */
function buildPreviewHtml(gameId, platform) {
  const gameJsPath = path.join(DIST_DIR, gameId, platform, 'game.js');
  if (!fs.existsSync(gameJsPath)) {
    throw new Error(`产物不存在: ${gameJsPath}\n请先运行: node src/build.js ${gameId} --platform ${platform}`);
  }
  const gameJs = fs.readFileSync(gameJsPath, 'utf8');
  /*
   * 【关键】内联进 <script> 前必须转义 `</script` 序列。
   * 产物内联了 shared.js 与游戏 HTML 骨架，其中含字面量 `</script>`
   * （HTML 解析器在 JS 字符串里也会识别它），浏览器会据此提前闭合脚本块，
   * 导致后半段被当作 HTML 解析并抛出 SyntaxError。
   * 注意：这只是「内联进 HTML 预览页」才有的问题；
   * 小游戏里 game.js 是独立文件，由平台加载，不存在此问题。
   */
  const gameJsSafe = gameJs.replace(/<\/script/gi, '<\\/script');

  const nsMap = { wechat: 'wx', douyin: 'tt', alipay: 'my', jd: 'jd' };
  const ns = nsMap[platform];
  // 支付宝不提供 WebAudio，用于验证降级路径
  const withAudio = platform !== 'alipay';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${gameId} · ${platform} 预览</title>
<style>
  html,body{margin:0;padding:0;height:100%;background:#11151c;
    font-family:system-ui,-apple-system,"PingFang SC",sans-serif;overflow:hidden}
  #stage{display:flex;align-items:center;justify-content:center;height:100%}
  #host{position:relative;box-shadow:0 8px 40px rgba(0,0,0,.6)}
  canvas{display:block;touch-action:none}
  #hud{position:fixed;left:0;right:0;top:0;padding:8px 12px;color:#8b949e;
    font-size:12px;display:flex;gap:16px;background:rgba(13,17,23,.8);
    border-bottom:1px solid #21262d;z-index:10}
  #hud b{color:#58a6ff;font-weight:600}
  #err{position:fixed;left:0;right:0;bottom:0;max-height:40%;overflow:auto;
    padding:10px 12px;color:#ff7b72;background:rgba(60,20,20,.95);
    font:11px/1.5 ui-monospace,monospace;white-space:pre-wrap;display:none;z-index:20}
  .dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:4px;vertical-align:1px}
  .ok{background:#3fb950}.bad{background:#f85149}.warn{background:#d29922}
</style>
</head>
<body>
<div id="hud">
  <span><span class="dot ok" id="dPlat"></span>平台 <b id="tPlat">-</b></span>
  <span><span class="dot ok" id="dAudio"></span>WebAudio <b id="tAudio">-</b></span>
  <span><span class="dot ok" id="dDom"></span>虚拟DOM <b id="tDom">-</b></span>
  <span><span class="dot ok" id="dRender"></span>UI绘制 <b id="tRender">-</b></span>
  <span id="tSize"></span>
</div>
<div id="stage"><div id="host"></div></div>
<div id="err"></div>

<script>
/* ===== 浏览器端错误捕获：把运行时异常显示出来，避免静默白屏 ===== */
(function(){
  // 此处 document 尚未被桥接劫持，可安全缓存原生引用
  var box = document.getElementById('err');
  function show(msg){ if(box){ box.style.display='block'; box.textContent += msg + '\\n'; } }
  window.addEventListener('error', function(e){ show('✗ ' + e.message + '  @' + (e.lineno||'?')); });
  window.addEventListener('unhandledrejection', function(e){ show('✗ Promise: ' + e.reason); });
  window.__showError = show;
})();

/* ===== 宿主桩：模拟小游戏运行时 ===== */
(function(){
  var W = 390, H = 844, DPR = 2;

  // 真实 canvas：这是本预览与 Node 沙盒验证的关键差别
  var real = document.createElement('canvas');
  real.width = W * DPR; real.height = H * DPR;
  real.style.width = W + 'px'; real.style.height = H + 'px';
  document.getElementById('host').appendChild(real);
  var rctx = real.getContext('2d');
  rctx.setTransform(DPR, 0, 0, DPR, 0, 0);

  // 上屏画布：createCanvas() 首次调用返回它
  var mainCanvas = {
    width: W * DPR, height: H * DPR,
    getContext: function(){ return rctx; },
    addEventListener: function(){}, removeEventListener: function(){},
    getBoundingClientRect: function(){ return {left:0,top:0,width:W,height:H,right:W,bottom:H}; },
    requestAnimationFrame: window.requestAnimationFrame.bind(window)
  };
  // 离屏画布：真实离屏 canvas，用于精灵烘焙路径
  function offscreen(){
    // 【关键】必须走桥接前缓存的原生 createElement。
    // 若用 document.createElement，会命中下方「canvas → 虚拟 DOM」桥接，
    // 而虚拟 DOM 的 createElement 又回调 MGCanvas.createOffscreen，形成无限递归。
    var c = origCE('canvas');
    c.width = 1; c.height = 1;
    c.style.display='none';
    document.body.appendChild(c);
    return c;
  }

  var store = {};
  var mainIssued = false;
  var nsApi = {
    // 与平台语义一致：首次调用返回上屏画布，其后返回真实离屏 canvas。
    // 若恒返回上屏桩对象，精灵烘焙会全部落在同一块画布上，
    // 且该桩对象不是合法的 CanvasImageSource，drawImage 会抛 TypeError。
    createCanvas: function(){
      if (!mainIssued) { mainIssued = true; return mainCanvas; }
      return offscreen();
    },
    getSystemInfoSync: function(){ return { windowWidth:W, windowHeight:H, pixelRatio:DPR, safeArea:null }; },
    setStorageSync: function(k,v){ store[k]=v; localStorage.setItem(k,v); },
    getStorageSync: function(k){ return k in store ? store[k] : (localStorage.getItem(k)||''); },
    removeStorageSync: function(k){ delete store[k]; localStorage.removeItem(k); },
    onTouchStart: function(cb){ bindTouch('touchstart',cb); },
    onTouchMove:  function(cb){ bindTouch('touchmove', cb); },
    onTouchEnd:   function(cb){ bindTouch('touchend',  cb); },
    onTouchCancel:function(cb){ bindTouch('touchcancel',cb); },
    onShow: function(){}, onHide: function(){}, onWindowResize: function(){},
    vibrateShort: function(){ if(navigator.vibrate) navigator.vibrate(15); }
  };
  ${withAudio ? `nsApi.createWebAudioContext = function(){ return new (window.AudioContext||window.webkitAudioContext)(); };`
              : `/* 支付宝路径：故意不提供 WebAudio，验证静音降级 */`}

  function bindTouch(type, cb){
    real.addEventListener(type, function(e){
      var t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
      cb({ touches: t ? [{clientX:t.clientX,clientY:t.clientY,identifier:0}] : [],
           changedTouches: t ? [{clientX:t.clientX,clientY:t.clientY,identifier:0}] : [],
           timeStamp: Date.now() });
    }, {passive:false});
  }
  window['${ns}'] = nsApi;
  window.__mainCanvas = mainCanvas;
  window.__W = W; window.__H = H;

  /*
   * 浏览器预览的固有约束：window / document 是只读槽位，无法替换，
   * 因此原生 document.getElementById 仍会被游戏代码直接调用。
   * 这里提前安装一个「延迟桥接」：原生查询先走原生 document，
   * 一旦适配层的虚拟 DOM 就绪（MGDocument 出现），
   * 后续查询自动切到虚拟 DOM。canvas 元素已在适配层代理到宿主画布。
   */
  var vdoc = null;
  var origGetId = document.getElementById.bind(document);
  var origQS    = document.querySelector.bind(document);
  var origCE    = document.createElement.bind(document);
  var origQSA   = document.querySelectorAll.bind(document);
  // 供状态面板使用：桥接前缓存的原生查询，避免面板节点被劫持
  window.__nativeGetId = origGetId;

  function tryBind(){
    if (vdoc) return true;
    if (window.MGDocument && window.MGDocument.getElementById) {
      vdoc = window.MGDocument;
      return true;
    }
    return false;
  }

  document.getElementById = function(id){
    if (tryBind()) { var v = vdoc.getElementById(id); if (v) return v; }
    return origGetId(id);
  };
  document.querySelector = function(sel){
    if (tryBind()) { var v = vdoc.querySelector(sel); if (v) return v; }
    return origQS(sel);
  };
  document.querySelectorAll = function(sel){
    if (tryBind()) { var v = vdoc.querySelectorAll(sel); if (v && v.length) return v; }
    return origQSA(sel);
  };
  document.createElement = function(tag){
    if (String(tag).toLowerCase()==='canvas' && tryBind()) return vdoc.createElement(tag);
    return origCE(tag);
  };
})();
</script>

<script>
/* ===== 状态面板 ===== */
/*
 * 注意：原生 document 已被桥接劫持，此处必须用【桥接前缓存的原生引用】
 * 查询面板元素，否则 getElementById('tPlat') 会打到虚拟 DOM 而拿不到节点。
 */
window.__mgState = { rendered: 0, errors: [] };
(function(){
  // 在任何桥接之前缓存原生引用
  var $ = function(id){ return window.__nativeGetId(id); };
  function poll(){
    var P = window.MGPlatform, U = window.MGUI;
    var tPlat = $('tPlat'), tAudio = $('tAudio');
    var tDom = $('tDom'), tRender = $('tRender');
    if (P){
      tPlat.textContent = P.label || P.id;
      $('dPlat').className = 'dot ' + (P.isRealHost?'warn':'ok');
      var hasAudio = P.caps.webAudio;
      tAudio.textContent = hasAudio ? '支持' : '已降级为静音';
      $('dAudio').className = 'dot ' + (hasAudio?'ok':'warn');
    }
    if (U){
      try {
        var root = window.MGDocument ? window.MGDocument._root() : null;
        var n = 0;
        (function walk(x){ (x.childNodes||[]).forEach(function(c){ if(c.nodeType===1){n++; walk(c);} }); })(root);
        tDom.textContent = n + ' 个元素';
        $('dDom').className = 'dot ' + (n>0?'ok':'bad');
      } catch(e){}
    }
    // 统计主画布是否有非空像素，作为「确实画出了东西」的判据
    try {
      var rctx = window.__mainCanvas.getContext('2d');
      var d = rctx.getImageData(0,0,Math.min(200,window.__W),Math.min(200,window.__H)).data;
      var nonzero = 0;
      for (var i=3;i<d.length;i+=4){ if(d[i]!==0) nonzero++; }
      window.__mgState.rendered = nonzero;
      tRender.textContent = nonzero + ' 像素';
      $('dRender').className = 'dot ' + (nonzero>0?'ok':'bad');
    } catch(e){
      tRender.textContent = '读取失败: '+e.message;
      $('dRender').className = 'dot bad';
    }
    $('tSize').textContent = window.__W+'×'+window.__H;
    window.__mgReady = true;
  }
  setTimeout(poll, 1500);
})();
</script>

<script>
/* ===== 游戏产物 ===== */
${gameJsSafe}
</script>
</body>
</html>`;
}

function main() {
  const argv = process.argv.slice(2);
  const gameId = argv.find(a => !a.startsWith('-'));
  const pIdx = argv.indexOf('--platform');
  const platform = (pIdx >= 0 && argv[pIdx + 1]) || 'wechat';
  const oIdx = argv.indexOf('--out');
  const outFile = (oIdx >= 0 && argv[oIdx + 1])
    ? path.resolve(argv[oIdx + 1])
    : path.join(ROOT, 'dist', '_preview', `${gameId}-${platform}.html`);

  if (!gameId) {
    console.log('用法: node src/preview.js <game-id> [--platform wechat|douyin|alipay|jd] [--out file.html]');
    process.exit(1);
  }

  const html = buildPreviewHtml(gameId, platform);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, html, 'utf8');
  console.log(`预览页已生成: ${outFile}`);
  console.log(`\n本地查看: open "${outFile}"`);
  console.log(`截图: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \\`);
  console.log(`  --headless --disable-gpu --screenshot=out.png --window-size=390,844 \\`);
  console.log(`  --virtual-time-budget=4000 "file://${outFile}"`);
}

if (require.main === module) main();
module.exports = { buildPreviewHtml };
