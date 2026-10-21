#!/usr/bin/env node
/*
 * build.js — 单文件 HTML 游戏 → 四平台小游戏工程 构建器
 * ---------------------------------------------------------------
 * 用法:
 *   node build.js <game-id> [--platform all|wechat|douyin|alipay|jd] [--out <dir>]
 *   node build.js --all
 *   node build.js --list
 *
 * 流程:
 *   1. 读取源 HTML，抽取 <style> / <script> / <body>
 *   2. 静态改写 JS（去掉浏览器专属 API 引用，注入适配层调用）
 *   3. 打包 runtime/ 适配层 + 游戏代码 → 单一 game.js
 *   4. 生成四平台各自的工程配置（game.json / project.config.json 等）
 *
 * 设计约束:
 *   - 游戏源码【零改动】：所有平台差异由 runtime 层吸收。
 *     改写步骤只做「必须做」的最小手术，且每处都可在 --verbose 下打印。
 */
'use strict';

const fs = require('fs');
const path = require('path');

// 注意：__dirname 指向 src/，所有工程目录都需以 src/ 的父级为基准
const ROOT = path.resolve(__dirname, '..');
const REPO = path.resolve(ROOT, '..');
const RUNTIME_DIR = path.join(ROOT, 'runtime');
const PLATFORM_DIR = path.join(ROOT, 'platform');
const GAMES_DIR = path.join(ROOT, 'games');
const DIST_DIR = path.join(ROOT, 'dist');
const PLATFORMS_JSON = path.join(ROOT, 'config', 'platforms.json');

/* ============ 工具 ============ */

const log = (...a) => console.log(...a);
const warn = (...a) => console.warn('  ⚠ ', ...a);

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeFile(p, content) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

/* ============ 游戏注册表 ============ */

/**
 * 读取 games/ 下的接入配置。
 * 每个游戏一个目录，内含 game.config.json，声明源文件与平台定制项。
 */
function loadGameConfigs() {
  if (!fs.existsSync(GAMES_DIR)) return [];
  return fs.readdirSync(GAMES_DIR)
    .filter(d => fs.statSync(path.join(GAMES_DIR, d)).isDirectory())
    .map(d => {
      const cfgPath = path.join(GAMES_DIR, d, 'game.config.json');
      if (!fs.existsSync(cfgPath)) return null;
      const cfg = readJSON(cfgPath);
      cfg.dir = path.join(GAMES_DIR, d);
      return cfg;
    })
    .filter(Boolean);
}

/* ============ HTML 抽取 ============ */

/**
 * 从单文件 HTML 中抽取三部分：CSS / JS / body DOM 骨架。
 * 抽取规则与运行时 mg-parser 保持一致，避免「构建期与运行期解析结果不同」。
 */
function extractParts(html) {
  // CSS：所有 <style> 块拼接
  const css = [];
  const styleRe = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = styleRe.exec(html))) css.push(m[1]);

  // JS：内联 <script>（无 src）与外链 <script src> 分开处理
  const inlineJs = [];
  const externalJs = [];
  const scriptRe = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
  while ((m = scriptRe.exec(html))) {
    const attrs = m[1] || '';
    const src = (attrs.match(/src\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (src) externalJs.push(src);
    else if (m[2] && m[2].trim()) inlineJs.push(m[2]);
  }

  // body 骨架：剥掉 <script> / <style> / <link> / <meta>，只留可视结构
  let body = '';
  const bm = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  body = bm ? bm[1] : html;
  body = body
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<link[^>]*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  return {
    css: css.join('\n'),
    js: inlineJs.join('\n;\n'),
    body: body.trim(),
    externalJs
  };
}

/* ============ JS 改写 ============ */

/**
 * 最小手术式改写。原则：能不改就不改，必须改的都留下显式标记。
 * 每条规则对应一个真实的平台约束，不是无意义替换。
 */
function transformJs(js, parts, cfg, verbose) {
  const changes = [];

  // 1) 移除 roundRect 兼容补丁：运行时 mg-canvas.patchContext 已统一处理，
  //    且补丁依赖 CanvasRenderingContext2D 构造器，在小游戏里挂载位置不同。
  const roundRectPatch = /if\s*\(\s*typeof\s+CanvasRenderingContext2D[\s\S]*?\n\s*\}\s*\n/;
  if (roundRectPatch.test(js)) {
    js = js.replace(roundRectPatch, '  // [mg] roundRect 补丁已由 runtime/mg-canvas.js 统一提供\n');
    changes.push('移除 CanvasRenderingContext2D.roundRect 兼容补丁（改由 runtime 提供）');
  }

  // 2) 移除 Google Fonts 外链依赖：小游戏禁止外链资源
  const fontLink = /@import\s+url\(['"]?https?:[^)]+\)[;]?/g;
  if (fontLink.test(js)) {
    js = js.replace(fontLink, '');
    changes.push('移除外链字体 @import（小游戏禁外链资源）');
  }

  // 3) visibilitychange / orientationchange：小游戏无此 DOM 事件，
  //    已在 mg-lifecycle 中用 onShow/onHide/onWindowResize 等价实现。
  //    这里不删除代码（保留原逻辑无害），仅在无法解析时报错前兜底。

  // 4) 外部依赖 ../shared.js：小游戏无 <script src>，需内联
  let sharedInlined = false;
  if (parts.externalJs.some(s => /shared\.js/.test(s))) {
    // 外链是相对于【源文件所在目录】的 ../shared.js，即仓库根目录
    const sharedPath = path.join(REPO, 'shared.js');
    if (fs.existsSync(sharedPath)) {
      /*
       * shared.js 以 `typeof window !== 'undefined' ? window : this` 决定挂载点。
       * 小游戏里 window 存在，它会挂到适配层的 win 上；而游戏代码用裸标识符
       * SharedGame 访问的是全局。因此内联后立即做一次挂载目标归一，
       * 保证两条路径拿到同一实例——必须在游戏代码求值【之前】完成，
       * 因为 plane-game 等游戏在顶层就调用了 SharedGame.Store.get。
       */
      const normalize = `
/* [mg] shared.js 挂载目标归一：window.SharedGame → globalThis.SharedGame */
(function () {
  if (typeof window !== 'undefined' && window.SharedGame &&
      typeof globalThis.SharedGame === 'undefined') {
    globalThis.SharedGame = window.SharedGame;
  } else if (typeof globalThis.SharedGame !== 'undefined' &&
             typeof window !== 'undefined' && !window.SharedGame) {
    window.SharedGame = globalThis.SharedGame;
  }
})();
`;
      js = `/* [mg] 内联 shared.js */\n` + fs.readFileSync(sharedPath, 'utf8') + '\n' + normalize + js;
      sharedInlined = true;
      changes.push('内联 shared.js + 挂载目标归一（小游戏不支持 <script src>）');
    } else {
      warn(`未找到 shared.js: ${sharedPath}`);
    }
  }

  if (verbose && changes.length) {
    changes.forEach(c => log('    · ' + c));
  }
  return { js, changes };
}

/* ============ 打包 ============ */

/**
 * 打包顺序即依赖顺序，不可调换。
 * 全部用 IIFE 包裹并挂到 globalThis，彼此只通过全局符号通信。
 */
const RUNTIME_ORDER = [
  'mg-platform.js',
  'mg-storage.js',
  'mg-canvas.js',
  'mg-audio.js',
  'mg-input.js',
  'mg-ui-layout.js',
  'mg-ui-render.js',
  'mg-parser.js',
  'mg-dom.js',
  'mg-lifecycle.js'
];

function packRuntime() {
  return RUNTIME_ORDER.map(f => {
    const p = path.join(RUNTIME_DIR, f);
    if (!fs.existsSync(p)) throw new Error(`缺少运行时文件: ${f}`);
    return `/* ===== runtime/${f} ===== */\n` + fs.readFileSync(p, 'utf8');
  }).join('\n;\n');
}

/**
 * 生成 game.js：适配层 + 游戏引导。
 * 游戏 JS 在适配层之后执行，保证 window/document/localStorage 等已就绪。
 */
function buildGameJs(parts, transformed, cfg, meta) {
  const title = cfg.title || meta.id;
  return `/*
 * ${title} — 小游戏适配产物
 * 平台: ${meta.platformLabel}
 * 生成时间: ${new Date().toISOString()}
 *
 * 本文件由 小游戏应用/src/build.js 自动生成，请勿手工编辑。
 * 重新生成: node build.js ${meta.id} --platform ${meta.platform}
 */
'use strict';

/* ================= 1. 适配层 ================= */
${packRuntime()}

/* ================= 2. 游戏 UI 骨架挂载 ================= */
/* [mg] 解析 <body> 为虚拟 DOM，并在同一画布上叠加渲染 */
(function () {
  var BODY_HTML = ${JSON.stringify(parts.body)};
  var CSS_TEXT  = ${JSON.stringify(parts.css)};
  if (globalThis.MGUI && globalThis.MGParser) {
    globalThis.MGUI.mount(BODY_HTML, CSS_TEXT);
  }
})();

/* ================= 3. 游戏本体（原样注入） ================= */
${transformed.js}

/* ================= 4. 启动 ================= */
(function () {
  if (typeof globalThis.MGLifecycle === 'undefined') return;
  var canvas = globalThis.MGCanvas ? globalThis.MGCanvas.getMain() : null;
  // 游戏自身通常已通过 document.getElementById('c') 拿到画布，
  // 若未取到则回退到适配层主画布。
  if (!canvas) {
    try { canvas = document.getElementById('c') || document.getElementById('canvas'); } catch (e) {}
  }
  globalThis.MGLifecycle.start(canvas, null);
  if (globalThis.console && console.log) {
    console.log('[mg] 平台=' + globalThis.MGPlatform.id +
                ' WebAudio=' + globalThis.MGPlatform.caps.webAudio);
  }
})();
`;
}

/* ============ 平台工程文件 ============ */

/** 各平台 game.json 差异：字段名与配置项不同 */
function buildGameJson(platformId, cfg, platformCfg) {
  const base = {
    deviceOrientation: cfg.orientation === 'landscape' ? 'landscape' : 'portrait',
    showStatusBar: false,
    networkTimeout: { request: 10000 },
    subpackages: []
  };

  switch (platformId) {
    case 'wechat':
      return {
        deviceOrientation: base.deviceOrientation,
        showStatusBar: false,
        networkTimeout: base.networkTimeout,
        subpackages: [],
        permission: {},
        workers: ''
      };
    case 'douyin':
      return {
        deviceOrientation: base.deviceOrientation,
        showStatusBar: false,
        networkTimeout: base.networkTimeout,
        subpackages: []
      };
    case 'alipay':
      return {
        deviceOrientation: base.deviceOrientation,
        showStatusBar: false,
        networkTimeout: base.networkTimeout,
        subpackages: []
      };
    case 'jd':
      return {
        deviceOrientation: base.deviceOrientation,
        showStatusBar: false,
        networkTimeout: base.networkTimeout,
        subpackages: []
      };
    default:
      return base;
  }
}

/** 各平台开发者工具工程配置 */
function buildProjectConfig(platformId, cfg) {
  const appid = (cfg.appid && cfg.appid[platformId]) || 'touristappid';
  const name = cfg.title || 'minigame';
  switch (platformId) {
    case 'wechat':
      return {
        appid,
        projectname: name,
        setting: { urlCheck: false, es6: false, enhance: false, postcss: false, minified: false },
        compileType: 'game',
        libVersion: '2.19.0',
        projectType: 'game'
      };
    case 'douyin':
      return {
        appid,
        projectname: name,
        setting: { urlCheck: false, es6: false },
        compileType: 'game',
        miniprogramRoot: './'
      };
    case 'alipay':
      return {
        appid,
        projectname: name,
        setting: { urlCheck: false, es6: false },
        compileType: 'game',
        miniprogramRoot: './'
      };
    case 'jd':
      return {
        appid,
        projectname: name,
        setting: { urlCheck: false, es6: false },
        compileType: 'game',
        miniprogramRoot: './'
      };
    default:
      return { appid, projectname: name };
  }
}

/** 平台入口文件：显式声明启动顺序，便于各平台开发者工具识别 */
function buildEntryJs(platformId) {
  const notes = {
    wechat: '微信小游戏入口。game.json 需配置 deviceOrientation。',
    douyin: '抖音小游戏入口。注意 WebAudio 走 tt.getAudioContext()。',
    alipay: '支付宝小游戏入口。无 WebAudio，音效将降级为静音。',
    jd: '京东小游戏入口。能力按微信对齐，WebAudio 等增强能力走运行时探测。'
  };
  return `/*
 * ${notes[platformId] || '小游戏入口'}
 * 本文件仅作平台识别与冷启动提示，核心逻辑在 game.js。
 */
require('./game.js');
`;
}

/* ============ 构建主流程 ============ */

function buildGame(cfg, platformIds, outDir, verbose) {
  const platforms = readJSON(PLATFORMS_JSON).platforms;
  const srcPath = path.resolve(REPO, cfg.source);
  if (!fs.existsSync(srcPath)) throw new Error(`源文件不存在: ${srcPath}`);

  const html = fs.readFileSync(srcPath, 'utf8');
  const parts = extractParts(html);
  const transformed = transformJs(parts.js, parts, cfg, verbose);

  if (verbose) {
    log(`  源文件: ${path.relative(REPO, srcPath)} (${(html.length / 1024).toFixed(1)} KB)`);
    log(`  抽取: CSS ${(parts.css.length / 1024).toFixed(1)} KB / ` +
        `JS ${(transformed.js.length / 1024).toFixed(1)} KB / ` +
        `body ${(parts.body.length / 1024).toFixed(1)} KB`);
  }

  const results = [];
  for (const pid of platformIds) {
    const pc = platforms[pid];
    if (!pc) { warn(`未知平台: ${pid}`); continue; }

    const target = path.join(outDir, cfg.id, pid);
    ensureDir(target);

    const gameJs = buildGameJs(parts, transformed, cfg, {
      id: cfg.id, platform: pid, platformLabel: pc.label
    });
    writeFile(path.join(target, 'game.js'), gameJs);
    writeFile(path.join(target, pc.configFile), JSON.stringify(buildGameJson(pid, cfg, pc), null, 2));
    writeFile(path.join(target, pc.projectConfig),
              JSON.stringify(buildProjectConfig(pid, cfg), null, 2));
    writeFile(path.join(target, 'game.entry.js'), buildEntryJs(pid));

    // 附一份构建诊断，便于排查平台差异
    const diag = {
      game: cfg.id,
      platform: pid,
      platformLabel: pc.label,
      namespace: pc.ns,
      capabilities: pc.capabilities,
      sourceSizeKB: +(html.length / 1024).toFixed(1),
      outputSizeKB: +(gameJs.length / 1024).toFixed(1),
      jsTransformations: transformed.changes,
      notes: pc.notes
    };
    writeFile(path.join(target, 'build-report.json'), JSON.stringify(diag, null, 2));

    results.push({ platform: pid, dir: target, sizeKB: +(gameJs.length / 1024).toFixed(1), diag });
  }
  return results;
}

/* ============ 诊断输出 ============ */

function printDegradation(results) {
  const lost = new Map();
  results.forEach(r => {
    const caps = r.diag.capabilities;
    if (!caps.webAudio.supported) {
      lost.set('WebAudio 程序化音效', caps.webAudio.supported === false
        ? `${r.diag.platformLabel} 官方仅提供音频文件播放接口，无 WebAudio 合成能力`
        : `${r.diag.platformLabel} 能力未知，运行时探测失败将降级`);
    }
    if (!caps.offscreenCanvas.supported) {
      lost.set('离屏 Canvas 预渲染', `${r.diag.platformLabel} 无标准离屏 canvas`);
    }
    if (!caps.orientation.supported) {
      lost.set('运行时横竖屏切换', `${r.diag.platformLabel} 不支持 setDeviceOrientation`);
    }
  });
  if (!lost.size) return;
  log('');
  for (const [cap, why] of lost) log(`    · ${cap} — ${why}`);
}

/* ============ CLI ============ */

function parseArgs(argv) {
  const args = { _: [], platform: 'all', out: DIST_DIR, verbose: false, all: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--platform' || a === '-p') args.platform = argv[++i];
    else if (a === '--out' || a === '-o') args.out = path.resolve(argv[++i]);
    else if (a === '--verbose' || a === '-v') args.verbose = true;
    else if (a === '--all') args.all = true;
    else if (a === '--list' || a === '-l') args.list = true;
    else args._.push(a);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const configs = loadGameConfigs();

  if (args.list || (args._.length === 0 && !args.all)) {
    log('\n可用游戏（games/*/game.config.json）:');
    if (!configs.length) {
      log('  （未找到任何接入配置）');
    } else {
      configs.forEach(c => {
        log(`  ${c.id.padEnd(20)} ${(c.title || '').padEnd(24)} ${c.source}`);
      });
    }
    log('\n用法:');
    log('  node build.js <game-id> [--platform all|wechat|douyin|alipay|jd] [--verbose]');
    log('  node build.js --all [--verbose]');
    log('  node build.js --list');
    log('');
    return;
  }

  const targets = args.all ? configs : configs.filter(c => args._.includes(c.id) || args._.includes(c.dir));
  if (!targets.length) {
    warn(`未匹配到游戏: ${args._.join(', ')}`);
    log('用 node build.js --list 查看可用游戏。');
    return;
  }

  const platformIds = args.platform === 'all'
    ? ['wechat', 'douyin', 'alipay', 'jd']
    : args.platform.split(',').map(s => s.trim());

  ensureDir(args.out);
  log(`\n构建输出目录: ${args.out}`);

  const allResults = [];
  for (const cfg of targets) {
    log(`\n▶ ${cfg.id}  ${cfg.title || ''}`);
    try {
      const results = buildGame(cfg, platformIds, args.out, args.verbose);
      results.forEach(r => {
        log(`  ✓ ${r.diag.platformLabel.padEnd(12)} ${String(r.sizeKB).padStart(7)} KB  ${path.relative(process.cwd(), r.dir)}`);
      });
      allResults.push(...results);
    } catch (e) {
      warn(`${cfg.id} 构建失败: ${e.message}`);
      if (args.verbose) console.error(e.stack);
    }
  }

  if (allResults.length) {
    log('\n能力降级说明:');
    printDegradation(allResults);
  }
  log('\n完成。产物已可直接导入对应平台开发者工具。\n');
}

if (require.main === module) main();

module.exports = { extractParts, transformJs, buildGame, RUNTIME_ORDER };
