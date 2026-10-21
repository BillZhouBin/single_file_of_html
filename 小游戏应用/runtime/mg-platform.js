/*
 * mg-platform.js — 平台探测与能力归一层
 * ---------------------------------------------------------------
 * 职责：识别当前宿主平台，探测能力可用性，向其余适配模块暴露统一接口。
 *
 * 设计原则（重要）：
 *   1. 能力靠【运行时探测】，不靠文档假设。支付宝无 WebAudio、京东能力未知，
 *      这些都是真机上才会暴露的差异，硬编码 if (platform==='alipay') 必然踩坑。
 *   2. 探测失败一律降级，绝不抛错打断游戏。
 *   3. 其余模块只读本模块的 `caps`，不直接接触 wx/tt/my/jd 全局对象。
 */
(function (global) {
  'use strict';

  /* ============ 1. 宿主平台识别 ============ */

  // 顺序敏感：jd 与 wx 在部分容器中可能同时存在符号，按专用前缀优先。
  var CANDIDATES = [
    { id: 'jd',      ns: 'jd', label: '京东小游戏' },
    { id: 'douyin',  ns: 'tt', label: '抖音小游戏' },
    { id: 'alipay',  ns: 'my', label: '支付宝小游戏' },
    { id: 'wechat',  ns: 'wx', label: '微信小游戏' }
  ];

  function detectHost() {
    for (var i = 0; i < CANDIDATES.length; i++) {
      var c = CANDIDATES[i];
      var api = global[c.ns];
      // 要求命名空间存在且具备小游戏标志性 API，避免在普通浏览器里误判
      if (api && (typeof api.createCanvas === 'function' ||
                  typeof api.createCanvasContext === 'function' ||
                  typeof api.getSystemInfoSync === 'function')) {
        return c;
      }
    }
    // 开发期在浏览器里预览：退化为 wechat 兼容模式，但不视为真机
    return { id: 'web', ns: 'wx', label: '浏览器预览' };
  }

  var host = detectHost();
  var api = global[host.ns] || {};

  /* ============ 2. 屏幕与系统信息 ============ */

  function readSystemInfo() {
    var info = null;
    try {
      if (typeof api.getWindowInfo === 'function') {
        info = api.getWindowInfo();          // 新版接口，微信 2.20.1+ / 抖音 / 支付宝
      } else if (typeof api.getSystemInfoSync === 'function') {
        info = api.getSystemInfoSync();      // 旧版通用接口
      } else if (typeof api.getSystemInfo === 'function') {
        info = api.getSystemInfo();
      }
    } catch (e) { info = null; }
    return info || {};
  }

  var sys = readSystemInfo();

  // 逻辑尺寸（CSS px）：小游戏 canvas 的坐标系即逻辑像素
  var winWidth  = sys.windowWidth  || sys.screenWidth  || 375;
  var winHeight = sys.windowHeight || sys.screenHeight || 667;
  var pixelRatio = sys.pixelRatio || 1;

  /* ============ 3. 能力探测 ============ */

  // WebAudio：四平台差异最大的一项。
  //   微信 wx.createWebAudioContext()   基础库 2.19.0+
  //   抖音 tt.getAudioContext()         基础库 1.34.0+，同步方法
  //   支付宝 —— 官方仅 createInnerAudioContext，无合成能力
  //   京东  —— 未知，尝试后回退
  function probeWebAudio() {
    var factories = [
      ['createWebAudioContext', function () { return api.createWebAudioContext(); }],
      ['getAudioContext',       function () { return api.getAudioContext(); }]
    ];
    for (var i = 0; i < factories.length; i++) {
      var name = factories[i][0];
      if (typeof api[name] !== 'function') continue;
      try {
        var ctx = factories[i][1]();
        // 关键校验：光有 context 不够，必须真的能合成
        if (ctx && typeof ctx.createOscillator === 'function' &&
            typeof ctx.createGain === 'function' &&
            typeof ctx.destination !== 'undefined') {
          return { ok: true, factory: name, ctx: ctx };
        }
        // context 存在但缺少合成节点（支付宝式的半支持）：视为不支持
      } catch (e) { /* 基础库版本过低会走到这里，继续尝试下一个 */ }
    }
    return { ok: false, factory: null, ctx: null };
  }

  // Canvas：微信/抖音首调返回上屏 canvas，第二次起返回离屏。
  // 这里只探测能力，不实际消耗首次调用（首次调用留给游戏主画布，见 mg-canvas.js）。
  function probeCanvas() {
    var hasCreateCanvas = typeof api.createCanvas === 'function';
    var hasLegacyContext = typeof api.createCanvasContext === 'function';
    return {
      createCanvas: hasCreateCanvas,
      legacyContext: hasLegacyContext && !hasCreateCanvas,
      // 任一路径存在即认为可创建画布，具体形态由 mg-canvas 决定
      usable: hasCreateCanvas || hasLegacyContext
    };
  }

  // 触摸
  function probeTouch() {
    return {
      start: typeof api.onTouchStart === 'function',
      move:  typeof api.onTouchMove === 'function',
      end:   typeof api.onTouchEnd === 'function',
      cancel: typeof api.onTouchCancel === 'function'
    };
  }

  // 生命周期
  function probeLifecycle() {
    return {
      onShow: typeof api.onShow === 'function',
      onHide: typeof api.onHide === 'function',
      onWindowResize: typeof (api.onWindowResize || api.onWindowSizeChange) === 'function'
    };
  }

  // 屏幕方向
  function probeOrientation() {
    var fn = api.setDeviceOrientation || api.setScreenOrientation;
    return { supported: typeof fn === 'function', fn: fn || null };
  }

  var webAudio = probeWebAudio();
  var canvasCap = probeCanvas();

  var caps = {
    webAudio:    webAudio.ok,
    canvas:      canvasCap.usable,
    offscreen:   canvasCap.createCanvas,   // 首调上屏、次调离屏
    legacyCtx:   canvasCap.legacyContext,  // 支付宝旧式命令队列
    touch:       probeTouch(),
    lifecycle:   probeLifecycle(),
    orientation: probeOrientation().supported,
    vibrate:     typeof api.vibrateShort === 'function' || typeof api.vibrate === 'function',
    storage: {
      sync: typeof api.setStorageSync === 'function',
      async: typeof api.setStorage === 'function'
    }
  };

  /* ============ 4. 对外接口 ============ */

  var Platform = {
    id: host.id,
    label: host.label,
    ns: host.ns,
    api: api,
    caps: caps,
    isRealHost: host.id !== 'web',

    /** 屏幕信息（可变，resize 后需重新读取） */
    getScreen: function () {
      return {
        width: winWidth,
        height: winHeight,
        pixelRatio: pixelRatio,
        safeArea: sys.safeArea || null
      };
    },

    /** resize 后刷新缓存 */
    refreshScreen: function () {
      sys = readSystemInfo();
      winWidth  = sys.windowWidth  || sys.screenWidth  || winWidth;
      winHeight = sys.windowHeight || sys.screenHeight || winHeight;
      pixelRatio = sys.pixelRatio || pixelRatio;
      return Platform.getScreen();
    },

    /** 已探测好的 WebAudio 上下文（探测失败则为 null） */
    getAudioContext: function () { return webAudio.ctx; },

    /** 震动；不支持时静默 */
    vibrate: function (opts) {
      try {
        if (typeof api.vibrateShort === 'function') {
          api.vibrateShort({ type: opts && opts.type || 'light' });
        } else if (typeof api.vibrate === 'function') {
          api.vibrate({ type: opts && opts.type || 'light' });
        }
      } catch (e) { /* 设备不支持时忽略 */ }
    },

    /** 保持屏幕常亮；不支持时静默 */
    keepScreenOn: function (on) {
      try {
        if (typeof api.setKeepScreenOn === 'function') api.setKeepScreenOn({ keepOn: !!on });
      } catch (e) {}
    },

    /**
     * 平台能力降级说明。用于构建期生成诊断报告，
     * 帮开发者知道「这个游戏在当前平台会失去哪些能力」。
     */
    degradation: function () {
      var lost = [];
      if (!caps.webAudio) {
        lost.push({
          level: 'high',
          cap: 'WebAudio 程序化音效',
          reason: host.id === 'alipay'
            ? '支付宝小游戏官方仅提供 createInnerAudioContext（播放音频文件），无 WebAudio 合成接口'
            : '当前宿主未提供可用的 WebAudio 合成接口',
          impact: '全部音效与 BGM 静音'
        });
      }
      if (!caps.offscreen) {
        lost.push({
          level: 'medium',
          cap: '离屏 Canvas 预渲染',
          reason: '仅提供旧式 createCanvasContext，语义为命令队列（需 draw() 提交）',
          impact: '精灵烘焙路径需改用旧式 API 或回退为直接绘制'
        });
      }
      if (!caps.orientation) {
        lost.push({
          level: 'low',
          cap: '运行时横竖屏切换',
          reason: '平台未提供 setDeviceOrientation',
          impact: '横屏游戏需固定为设计朝向'
        });
      }
      return lost;
    }
  };

  global.MGPlatform = Platform;

  // 开发期在浏览器打开 dist 产物时给出显式提示，避免误判为真机环境
  if (!Platform.isRealHost && typeof console !== 'undefined' && console.info) {
    console.info('[mg] 未检测到小游戏宿主，已进入浏览器预览模式。' +
                 'WebAudio / 存储 / 震动将使用降级实现，真机表现以开发者工具为准。');
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
