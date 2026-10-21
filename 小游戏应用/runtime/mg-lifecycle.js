/*
 * mg-lifecycle.js — 生命周期与主循环
 * ---------------------------------------------------------------
 * 负责：
 *   1. 按正确顺序装配各适配层（依赖是单向的，不能乱序）
 *   2. 接管主循环：游戏 rAF 帧 → 游戏画布 → UI 覆盖层 → 提交
 *   3. 处理 onShow / onHide / resize / 横竖屏切换
 *
 * 装配顺序（不可调换）：
 *   mg-platform → mg-storage → mg-canvas → mg-audio → mg-input
 *   → mg-parser → mg-ui-layout → mg-ui-render → mg-dom → 本模块
 */
(function (global) {
  'use strict';

  var P = global.MGPlatform;
  var api = P.api;

  var gameCanvas = null;    // 游戏主画布
  var gameCtx = null;       // 游戏绘图上下文
  var uiPaused = false;
  var running = false;

  /* ============ 主循环 ============ */

  var nativeRAF = global.requestAnimationFrame
    ? global.requestAnimationFrame.bind(global)
    : function (cb) { return setTimeout(function () { cb(Date.now()); }, 16); };

  /**
   * 启动渲染循环。
   *
   * 与 Web 的差异：Web 是「canvas 与 DOM 各画各的」，
   * 小游戏只有一块上屏画布，因此 UI 覆盖层必须在游戏帧之后、同一上下文上绘制，
   * 才能获得与 DOM 叠加相同的视觉结果。
   */
  function start(canvas, onFrame) {
    gameCanvas = canvas;
    gameCtx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
    if (global.MGCanvas) global.MGCanvas.patchContext(gameCtx);

    running = true;
    var last = Date.now();

    function loop() {
      if (!running) return;
      try {
        var now = Date.now();
        var dt = now - last;
        last = now;
        // 切后台回来 dt 可能极大，钳制避免一帧内物理穿模
        if (dt > 100) dt = 100;

        // 1) 推进游戏逻辑
        if (onFrame) onFrame(dt, now);

        // 2) 绘制 UI 覆盖层（游戏已画完，同一上下文叠加）
        if (gameCtx && global.MGUI && !uiPaused) {
          try { global.MGUI.render(gameCtx); } catch (e) { /* UI 异常不阻断游戏 */ }
        }

        // 3) 提交（支付宝旧式上下文需要；标准 2D 上下文无此方法）
        if (gameCtx && typeof gameCtx.draw === 'function' && P.caps.legacyCtx) {
          try { gameCtx.draw(); } catch (e) {}
        }
      } catch (e) {
        if (global.console && console.error) console.error('[mg-loop]', e);
      }
      nativeRAF(loop);
    }
    nativeRAF(loop);
  }

  function stop() { running = false; }

  /* ============ 前后台切换 ============ */

  function onShow() {
    uiPaused = false;
    if (global.MGAudio) global.MGAudio.resume();
    if (global.MGUI) global.MGUI.invalidate();     // 回前台后重新按新尺寸布局
  }

  function onHide() {
    // 切后台后停止绘制，省电并避免部分平台直接挂起 rAF
    uiPaused = true;
    if (global.MGAudio && global.MGAudio.context) {
      try { if (global.MGAudio.context.state === 'running') global.MGAudio.context.suspend(); }
      catch (e) {}
    }
  }

  /* ============ 尺寸变化 ============ */

  function onResize() {
    if (global.MGCanvas) global.MGCanvas.resize();
    if (global.MGUI) global.MGUI.invalidate();
  }

  /* ============ 绑定平台事件 ============ */

  function bindPlatformEvents() {
    var lc = P.caps.lifecycle;

    if (P.isRealHost) {
      if (lc.onShow && typeof api.onShow === 'function') {
        api.onShow(onShow);
      }
      if (lc.onHide && typeof api.onHide === 'function') {
        api.onHide(onHide);
      }
      var resizeFn = api.onWindowResize || api.onWindowSizeChange;
      if (lc.onWindowResize && typeof resizeFn === 'function') {
        resizeFn(onResize);
      }
    } else if (typeof global.addEventListener === 'function') {
      global.addEventListener('resize', onResize);
      global.addEventListener('orientationchange', onResize);
      // 页面隐藏（切后台）时暂停绘制
      if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('visibilitychange', function () {
          if (document.hidden) onHide(); else onShow();
        });
      }
    }
  }

  /* ============ 导出 ============ */

  global.MGLifecycle = {
    start: start,
    stop: stop,
    onShow: onShow,
    onHide: onHide,
    onResize: onResize,
    bindPlatformEvents: bindPlatformEvents,
    getGameCanvas: function () { return gameCanvas; },
    getGameCtx: function () { return gameCtx; }
  };

  bindPlatformEvents();
})(typeof globalThis !== 'undefined' ? globalThis : this);
