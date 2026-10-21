/*
 * mg-input.js — 输入事件兼容层
 * ---------------------------------------------------------------
 * 本合集游戏混用三套指针事件（pointer / mouse / touch），共 20+ 处绑定。
 * 小游戏只提供 onTouchStart/Move/End/Cancel，回调参数结构也不同：
 *
 *   小游戏:  cb({ touches: [{ clientX, clientY, identifier }], changedTouches: [...], timeStamp })
 *   DOM:     e.clientX / e.clientY / e.touches[0] / e.preventDefault()
 *
 * 本层的职责是【双向】打通：
 *   触摸 → pointer* + mouse* + touch* 三套 DOM 风格事件
 *   键盘 → 浏览器预览期可用；真机无键盘，作为可选增强路径
 *
 * 坐标系统一为 CSS 逻辑像素，与 Canvas 绘制坐标一致。
 */
(function (global) {
  'use strict';

  var P = global.MGPlatform;
  var api = P.api;
  var t = P.caps.touch;

  /* ============ 事件监听器存储 ============ */

  var listeners = {};   // { target: { type: [fn, ...] } }

  function addEventListener(target, type, fn) {
    if (!fn) return;
    (listeners[target] || (listeners[target] = {}));
    (listeners[target][type] || (listeners[target][type] = [])).push(fn);
  }

  function removeEventListener(target, type, fn) {
    var arr = listeners[target] && listeners[target][type];
    if (!arr) return;
    var i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }

  /**
   * 向一组监听器派发事件。
   * 单个监听器抛错不应中断其他监听器——小游戏无错误边界，
   * 一个 UI 按钮回调出错会导致整帧逻辑停摆。
   */
  function dispatch(target, type, evt) {
    var arr = listeners[target] && listeners[target][type];
    if (!arr || !arr.length) return;
    // 复制一份，允许监听器内部增删监听器
    var snapshot = arr.slice();
    for (var i = 0; i < snapshot.length; i++) {
      try { snapshot[i](evt); }
      catch (e) {
        if (global.console && console.error) {
          console.error('[mg-input] ' + type + ' 监听器异常：', e);
        }
      }
    }
  }

  /* ============ 事件对象构造 ============ */

  function makePoint(src, id) {
    return {
      clientX: src.clientX !== undefined ? src.clientX : (src.x || 0),
      clientY: src.clientY !== undefined ? src.clientY : (src.y || 0),
      pageX:   src.pageX   !== undefined ? src.pageX   : (src.x || 0),
      pageY:   src.pageY   !== undefined ? src.pageY   : (src.y || 0),
      identifier: id !== undefined ? id : 0,
      target: null
    };
  }

  function makeTouchEvent(type, points, changed) {
    var touches = points.map(function (p, i) { return makePoint(p, i); });
    var changedTouches = (changed || points).map(function (p, i) { return makePoint(p, i); });
    var first = touches[0] || changedTouches[0] || { clientX: 0, clientY: 0 };
    return {
      type: type,
      touches: touches,
      targetTouches: touches,
      changedTouches: changedTouches,
      clientX: first.clientX,
      clientY: first.clientY,
      pageX: first.pageX,
      pageY: first.pageY,
      timeStamp: Date.now(),
      // 小游戏无滚动/缩放，preventDefault 只需存在即可让 e.preventDefault() 不报错
      preventDefault: function () {},
      stopPropagation: function () {},
      cancelBubble: false
    };
  }

  function makePointerEvent(type, pt) {
    var p = makePoint(pt);
    return {
      type: type,
      clientX: p.clientX, clientY: p.clientY,
      pageX: p.pageX,     pageY: p.pageY,
      pointerId: p.identifier,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
      timeStamp: Date.now(),
      preventDefault: function () {},
      stopPropagation: function () {}
    };
  }

  function makeMouseEvent(type, pt) {
    var p = makePoint(pt);
    return {
      type: type,
      clientX: p.clientX, clientY: p.clientY,
      pageX: p.pageX,     pageY: p.pageY,
      button: 0,
      buttons: (type === 'mousedown') ? 1 : 0,
      timeStamp: Date.now(),
      preventDefault: function () {},
      stopPropagation: function () {}
    };
  }

  /* ============ 触摸 → 三套事件扇出 ============ */

  function extractPoints(e) {
    // 兼容两种参数形态：直接传点，或传 { touches }
    if (!e) return [];
    if (Array.isArray(e.touches)) {
      return e.touches.map(function (x) { return { x: x.clientX, y: x.clientY }; });
    }
    if (e.clientX !== undefined) return [{ x: e.clientX, y: e.clientY }];
    if (e.x !== undefined) return [{ x: e.x, y: e.y }];
    return [];
  }

  function onTouchStart(e) {
    var pts = extractPoints(e);
    if (!pts.length) return;
    var p0 = pts[0];
    dispatch('canvas', 'touchstart',  makeTouchEvent('touchstart',  pts, pts));
    dispatch('canvas', 'pointerdown', makePointerEvent('pointerdown', p0));
    dispatch('canvas', 'mousedown',   makeMouseEvent('mousedown', p0));
    if (global.MGAudio) global.MGAudio.unlock();   // 首次触摸解锁音频
  }

  function onTouchMove(e) {
    var pts = extractPoints(e);
    if (!pts.length) return;
    var p0 = pts[0];
    dispatch('canvas', 'touchmove',  makeTouchEvent('touchmove',  pts, pts));
    dispatch('canvas', 'pointermove', makePointerEvent('pointermove', p0));
    dispatch('canvas', 'mousemove',  makeMouseEvent('mousemove', p0));
  }

  function onTouchEnd(e) {
    var pts = extractPoints(e);
    if (!pts.length) return;
    // DOM 语义：touchend 时 touches 为空，坐标取 changedTouches
    dispatch('canvas', 'touchend',   makeTouchEvent('touchend', [], pts));
    dispatch('canvas', 'pointerup',  makePointerEvent('pointerup', pts[0]));
    dispatch('canvas', 'mouseup',    makeMouseEvent('mouseup', pts[0]));

    // 依赖 window 级 pointerup 的逻辑（如拖拽松手）也要收到
    dispatch('window', 'pointerup', makePointerEvent('pointerup', pts[0]));
    dispatch('window', 'touchend',  makeTouchEvent('touchend', [], pts));
    dispatch('window', 'mouseup',   makeMouseEvent('mouseup', pts[0]));
  }

  function onTouchCancel(e) {
    var pts = extractPoints(e);
    dispatch('canvas', 'touchcancel',  makeTouchEvent('touchcancel', [], pts));
    dispatch('canvas', 'pointercancel', makePointerEvent('pointercancel', pts[0] || { x: 0, y: 0 }));
    dispatch('window',  'pointercancel', makePointerEvent('pointercancel', pts[0] || { x: 0, y: 0 }));
  }

  /* ============ 平台事件绑定 ============ */

  if (P.isRealHost && t.start) {
    if (typeof api.onTouchStart === 'function')  api.onTouchStart(onTouchStart);
    if (typeof api.onTouchMove === 'function')   api.onTouchMove(onTouchMove);
    if (typeof api.onTouchEnd === 'function')    api.onTouchEnd(onTouchEnd);
    if (typeof api.onTouchCancel === 'function') api.onTouchCancel(onTouchCancel);
  } else if (typeof document !== 'undefined' && document.addEventListener) {
    // 浏览器预览：直接用 DOM 事件，仅做目标名归一（canvas/window 分派）
    var bridge = {
      touchstart: onTouchStart, touchmove: onTouchMove,
      touchend: onTouchEnd,     touchcancel: onTouchCancel
    };
    Object.keys(bridge).forEach(function (k) {
      document.addEventListener(k, function (e) {
        var pts = e.touches && e.touches.length
          ? [{ x: e.touches[0].clientX, y: e.touches[0].clientY }]
          : [{ x: e.clientX, y: e.clientY }];
        var ch = (e.changedTouches && e.changedTouches[0])
          ? { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY } : pts[0];
        if (k === 'touchstart') onTouchStart({ touches: pts });
        else if (k === 'touchmove') onTouchMove({ touches: pts });
        else if (k === 'touchend') onTouchEnd({ touches: [], changedTouches: [ch] });
        else onTouchCancel({ changedTouches: [ch] });
      }, { passive: false });
    });
  }

  /* ============ 键盘（可选增强路径） ============ */

  var keys = {};

  function onKey(type, e) {
    var k = e.key;
    if (type === 'keydown') keys[k] = true; else keys[k] = false;
    dispatch('window', type, {
      type: type, key: k, code: e.code,
      preventDefault: function () {}, stopPropagation: function () {}
    });
  }

  if (!P.isRealHost && typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('keydown',  function (e) { onKey('keydown', e); });
    document.addEventListener('keyup',    function (e) { onKey('keyup', e); });
    document.addEventListener('blur',    function () { dispatch('window', 'blur', { type: 'blur' }); });
  }

  /* ============ shared.js Input 原语 ============ */

  /*
   * shared.js 的 SharedGame.Input 暴露 bindKeyboard / bindPointer / makeStick。
   * 游戏（如 plane-game）直接调用这些方法，因此 MGInput 必须提供同名同签名的实现，
   * 否则内联的 shared.js 在小游戏里会因方法缺失而抛错。
   */

  /**
   * 统一键盘监听。签名与 shared.js 一致。
   * 小游戏无物理键盘，本实现只在浏览器预览期生效；
   * 真机上所有游戏均已实现触摸输入，键盘不是必需路径。
   */
  function bindKeyboard(opts) {
    opts = opts || {};
    if (!P.isRealHost && typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('keydown', function (e) {
        if (opts.prevent && opts.prevent.indexOf(e.key) >= 0 && e.preventDefault) e.preventDefault();
        keys[e.key] = true;
        if (opts.onDown) opts.onDown(e.key, e);
      });
      document.addEventListener('keyup', function (e) {
        keys[e.key] = false;
        if (opts.onUp) opts.onUp(e.key, e);
      });
      document.addEventListener('blur', function () {
        for (var k in keys) keys[k] = false;
      });
    }
  }

  /**
   * 指针拖拽绑定。签名与 shared.js 一致。
   * handlers: { down, move, up }，收到逻辑坐标 {x, y}
   */
  function bindPointer(canvas, handlers, toLogical) {
    handlers = handlers || {};
    function pos(e) {
      if (toLogical) {
        var r = canvas && canvas.getBoundingClientRect ? canvas.getBoundingClientRect()
               : { left: 0, top: 0, width: 1, height: 1 };
        return toLogical(e, r);
      }
      // 缺省返回归一化坐标（与 shared.js 行为一致）
      var rect = canvas && canvas.getBoundingClientRect ? canvas.getBoundingClientRect()
             : { left: 0, top: 0, width: global.MGPlatform.getScreen().width,
                 height: global.MGPlatform.getScreen().height };
      return { x: (e.clientX - rect.left) / (rect.width || 1),
               y: (e.clientY - rect.top) / (rect.height || 1) };
    }
    addEventListener('canvas', 'pointerdown', function (e) { if (handlers.down) handlers.down(pos(e), e); });
    addEventListener('canvas', 'pointermove', function (e) { if (handlers.move) handlers.move(pos(e), e); });
    addEventListener('window', 'pointerup',  function (e) { if (handlers.up)   handlers.up(e); });
    // 触摸事件同时挂一份，覆盖只监听 touch* 的游戏
    addEventListener('canvas', 'touchstart', function (e) { if (handlers.down) handlers.down(pos(e), e); });
    addEventListener('canvas', 'touchmove',  function (e) { if (handlers.move) handlers.move(pos(e), e); });
  }

  /**
   * 虚拟摇杆。返回 {active,x,y,dx,dy}，供 grass-survivor 等横屏游戏使用。
   * 小游戏无鼠标，因此只响应 touch 与 pen。
   */
  function makeStick(canvas, cb) {
    cb = cb || {};
    var stick = { active: false, x: 0, y: 0, dx: 0, dy: 0, id: null };
    function clamp(v) { return v < -1 ? -1 : (v > 1 ? 1 : v); }

    function start(cx, cy, src) {
      var s = global.MGPlatform.getScreen();
      stick.active = true; stick.id = src; stick.x = cx; stick.y = cy;
      stick.dx = clamp((cx / s.width - 0.5) * 2);
      stick.dy = clamp((cy / s.height - 0.5) * 2);
      if (cb.onStart) cb.onStart(stick);
    }
    function move(cx, cy) {
      if (!stick.active) return;
      var s = global.MGPlatform.getScreen();
      stick.x = cx; stick.y = cy;
      stick.dx = clamp((cx / s.width - 0.5) * 2);
      stick.dy = clamp((cy / s.height - 0.5) * 2);
      if (cb.onMove) cb.onMove(stick);
    }
    function end() {
      stick.active = false; stick.dx = 0; stick.dy = 0; stick.id = null;
      if (cb.onEnd) cb.onEnd();
    }

    addEventListener('canvas', 'touchstart', function (e) { if (e.clientX !== undefined) start(e.clientX, e.clientY, 'touch'); });
    addEventListener('canvas', 'touchmove',  function (e) { if (e.clientX !== undefined) move(e.clientX, e.clientY); });
    addEventListener('canvas', 'touchend',   end);
    addEventListener('canvas', 'touchcancel', end);
    addEventListener('canvas', 'pointerdown', function (e) { start(e.clientX, e.clientY, 'pointer'); });
    addEventListener('canvas', 'pointermove', function (e) { if (stick.id === 'pointer') move(e.clientX, e.clientY); });
    addEventListener('window',  'pointerup',  function () { if (stick.id === 'pointer') end(); });
    return stick;
  }

  /* ============ 导出 ============ */

  global.MGInput = {
    addEventListener: addEventListener,
    removeEventListener: removeEventListener,
    dispatch: dispatch,
    /** 按键状态表，与 shared.js 的 SharedGame.Input.keys 同构 */
    keys: keys,
    /* shared.js Input 原语（签名保持一致，便于内联后直接复用） */
    bindKeyboard: bindKeyboard,
    bindPointer: bindPointer,
    makeStick: makeStick,

    /**
     * 屏幕坐标 → Canvas 逻辑坐标。
     * 触摸事件已是逻辑像素（小游戏坐标系 = CSS px），此函数主要用于
     * 浏览器预览期的 devicePixelRatio 换算。
     */
    toLogical: function (clientX, clientY, canvas) {
      if (P.isRealHost || !canvas) return { x: clientX, y: clientY };
      var rect = canvas.getBoundingClientRect ? canvas.getBoundingClientRect()
             : { left: 0, top: 0, width: global.innerWidth, height: global.innerHeight };
      return { x: clientX - rect.left, y: clientY - rect.top };
    },

    /** 模拟点击（供 UI 兼容层做命中测试与自动化测试使用） */
    simulateTap: function (x, y) {
      var pt = { x: x, y: y };
      onTouchStart({ touches: [pt] });
      onTouchEnd({ touches: [], changedTouches: [pt] });
    }
  };

  // 注入全局 addEventListener：游戏里大量 `window.addEventListener('click', ...)`
  // 这类调用通过 MGWindow（见 mg-window.js）转发到本层。
})(typeof globalThis !== 'undefined' ? globalThis : this);
