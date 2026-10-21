/*
 * mg-canvas.js — Canvas 能力层
 * ---------------------------------------------------------------
 * 解决三个问题：
 *   1. 上屏 canvas 只有一块。首调 createCanvas() 必须留给游戏主画布，
 *      离屏预渲染（精灵烘焙）只能取第二次及以后的返回值。
 *   2. 支付宝只有旧式 createCanvasContext（命令队列，需 draw() 提交），
 *      与 getContext('2d') 的实时上下文语义不同，需补齐。
 *   3. 各平台 CanvasRenderingContext2D 原型挂在不同位置，
 *      roundRect 等新 API 在旧基础库上缺失，需打补丁。
 */
(function (global) {
  'use strict';

  var P = global.MGPlatform;
  var api = P.api;

  // 【关键】首调标记：保证上屏 canvas 归属于游戏主画布
  var createdCount = 0;
  var mainCanvas = null;
  var offscreenPool = [];

  /**
   * 创建画布。
   * @param {boolean} offscreen true=离屏（预渲染用）；false/省略=上屏主画布
   */
  function createCanvas(offscreen) {
    if (!P.caps.canvas) return null;

    // 上屏画布：无论调用次序，第一个 canvas 必须是主画布
    if (!offscreen && !mainCanvas) {
      createdCount++;
      mainCanvas = api.createCanvas();
      applyScreenMetrics(mainCanvas);
      return mainCanvas;
    }

    // 离屏画布：复用池中的画布，避免反复创建（小程序画布数量有上限）
    if (offscreen) {
      var reused = offscreenPool.pop();
      if (reused) {
        resetCanvas(reused);
        return reused;
      }
      createdCount++;
      var c = api.createCanvas();
      if (c) {
        // 离屏画布默认尺寸为 300x150，必须显式设定
        c.width = 0; c.height = 0;
        // 【关键】不要把刚创建的画布放入复用池。
        // 池的语义是「已释放、可复用」，而此处画布正准备交付给调用方；
        // 若入池，紧接着的第二次 createOffscreen 会 pop 出同一块画布并清零，
        // 表现为所有精灵烘焙到同一张图上、先前烘焙的内容被覆盖。
      }
      return c;
    }

    // 已占用主画布后的再次请求 → 退化为离屏
    createdCount++;
    return api.createCanvas();
  }

  /** 主画布：按屏幕尺寸与 DPR 设置后备缓冲分辨率 */
  function applyScreenMetrics(canvas) {
    var s = P.getScreen();
    canvas.width  = Math.round(s.width * s.pixelRatio);
    canvas.height = Math.round(s.height * s.pixelRatio);
    return canvas;
  }

  function resetCanvas(canvas) {
    if (!canvas) return canvas;
    canvas.width = 0;   // 置 0 是清空画布的可靠方式（比 clearRect 更彻底）
    canvas.height = 0;
    return canvas;
  }

  /** 主画布尺寸随屏幕变化更新（横竖屏切换 / 窗口 resize） */
  function resizeMain() {
    if (!mainCanvas) return null;
    var s = P.refreshScreen();
    mainCanvas.width  = Math.round(s.width * s.pixelRatio);
    mainCanvas.height = Math.round(s.height * s.pixelRatio);
    // 旧式上下文（支付宝）无 width/height 后备缓冲概念，需另行处理
    return mainCanvas;
  }

  function getMainCanvas() { return mainCanvas; }

  /* ============ CanvasRenderingContext2D 原型补丁 ============ */

  function getProto(ctx) {
    if (!ctx) return null;
    // 各平台原型挂载位置不一致，逐个尝试
    var ctor = global.CanvasRenderingContext2D;
    if (ctor && ctor.prototype) return ctor.prototype;
    if (ctx.constructor && ctx.constructor.prototype) return ctx.constructor.prototype;
    if (ctx.__proto__) return ctx.__proto__;
    return null;
  }

  /**
   * 补齐小游戏环境下缺失的 CanvasRenderingContext2D 方法。
   * 目前已知需要：roundRect（旧基础库）、setLineDash（部分平台缺失）。
   * 幂等：重复调用无副作用。
   */
  function patchContextProto(ctx) {
    // 必须拿到一个真实上下文才能定位原型：各平台把 CanvasRenderingContext2D
    // 挂在不同的地方，没有实例就无从推断。缺省回退到主画布的上下文。
    if (!ctx && mainCanvas && typeof mainCanvas.getContext === 'function') {
      try { ctx = mainCanvas.getContext('2d'); } catch (e) { ctx = null; }
    }
    var proto = getProto(ctx);
    if (!proto || proto.__mgPatched) return;
    proto.__mgPatched = true;

    // roundRect：Chrome 99+ / 部分平台基础库仍未实现
    if (typeof proto.roundRect !== 'function') {
      proto.roundRect = function (x, y, w, h, r) {
        if (typeof r === 'number') r = [r, r, r, r];
        else if (Array.isArray(r)) { while (r.length < 4) r.push(r[0]); }
        else r = [0, 0, 0, 0];
        var tl = r[0], tr = r[1], br = r[2], bl = r[3];
        this.moveTo(x + tl, y);
        this.lineTo(x + w - tr, y);
        this.arcTo(x + w, y, x + w, y + tr, tr);
        this.lineTo(x + w, y + h - br);
        this.arcTo(x + w, y + h, x + w - br, y + h, br);
        this.lineTo(x + bl, y + h);
        this.arcTo(x, y + h, x, y + h - bl, bl);
        this.lineTo(x, y + tl);
        this.arcTo(x, y, x + tl, y, tl);
        return this;
      };
    }

    // setLineDash：Android 低端机 WebView 常缺失
    if (typeof proto.setLineDash !== 'function') {
      proto.setLineDash = function () { return this; };
    }
    if (typeof proto.getLineDash !== 'function') {
      proto.getLineDash = function () { return []; };
    }

    // drawImage：游戏常把 document.createElement('canvas') 得到的【虚拟节点】
    // 直接作为精灵传给 drawImage。虚拟节点不是合法的 CanvasImageSource，
    // 必须解包到它代理的宿主画布，否则真机与预览都会抛 TypeError。
    if (typeof proto.drawImage === 'function' && !proto.__mgDrawImagePatched) {
      proto.__mgDrawImagePatched = true;
      var rawDrawImage = proto.drawImage;
      proto.drawImage = function (img) {
        var args = Array.prototype.slice.call(arguments);
        if (img && img._hostCanvas) args[0] = img._hostCanvas;
        return rawDrawImage.apply(this, args);
      };
    }
  }

  /* ============ 导出 ============ */

  global.MGCanvas = {
    create: createCanvas,
    createOffscreen: function () { return createCanvas(true); },
    getMain: getMainCanvas,
    resize: resizeMain,
    patchContext: patchContextProto,

    /**
     * 为画布设置逻辑尺寸并按 DPR 缩放上下文。
     * 游戏里 canvas 的 CSS 尺寸（逻辑像素）与后备缓冲分辨率解耦，
     * 这样所有绘制代码继续用逻辑坐标，无需关心 DPR。
     */
    setupHiDPI: function (canvas, logicalW, logicalH) {
      var s = P.getScreen();
      canvas.width  = Math.round(logicalW * s.pixelRatio);
      canvas.height = Math.round(logicalH * s.pixelRatio);
      var ctx = canvas.getContext('2d');
      if (ctx && typeof ctx.setTransform === 'function') {
        ctx.setTransform(s.pixelRatio, 0, 0, s.pixelRatio, 0, 0);
      } else if (ctx) {
        // 无 setTransform 时用 scale 近似
        ctx.scale(s.pixelRatio, s.pixelRatio);
      }
      return ctx;
    },

    /** 统计信息，供构建期诊断输出 */
    stats: function () {
      return { created: createdCount, offscreenPooled: offscreenPool.length };
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
