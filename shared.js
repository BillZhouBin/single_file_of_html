/*
 * shared.js — 单文件 HTML 游戏合集 · 跨游戏共享模块
 * ---------------------------------------------------------------
 * 三件套（零外部依赖、零 DOM 假设，可外链）：
 *   SharedGame.Store  — localStorage 封装（JSON + 容错，兼容旧字符串值）
 *   SharedGame.Audio  — Web Audio 程序化音效（共享 AudioContext 单例 + 开关）
 *   SharedGame.Input  — 键盘状态对象 + 指针 / 虚拟摇杆绑定原语
 *
 * 用法（放在游戏 <script> 之前）：
 *   <script src="../shared.js"></script>
 *   <script> const A = SharedGame.Audio, keys = SharedGame.Input.keys; ... </script>
 */
(function (global) {
  'use strict';

  /* ============ Store：localStorage 封装（JSON + 容错） ============ */
  var Store = {
    get: function (key, def) {
      try {
        var raw = global.localStorage.getItem(key);
        if (raw === null || raw === undefined) return def;
        try { return JSON.parse(raw); } catch (e) { return raw; } // 兼容旧的非 JSON 字符串
      } catch (e) { return def; }
    },
    set: function (key, val) {
      try {
        global.localStorage.setItem(key, typeof val === 'string' ? val : JSON.stringify(val));
        return true;
      } catch (e) { return false; }
    },
    del: function (key) {
      try { global.localStorage.removeItem(key); } catch (e) {}
    },

    // JSON 便捷方法：多款游戏按 getJSON/setJSON 调用，必须提供，
    // 否则会因为「方法不存在」在初始化阶段直接抛错、按钮全绑不上。
    getJSON: function (key, def) {
      var v = Store.get(key, undefined);
      if (v === undefined || v === null) return def;
      if (typeof v === 'object') return v;          // get() 已解析过
      try { return JSON.parse(v); } catch (e) { return def; }
    },
    setJSON: function (key, val) { return Store.set(key, val); }
  };

  /* ============ Audio：Web Audio 程序化音效（共享单例） ============ */
  var AC = null;
  var enabled = true;

  function ensure() {
    if (!AC) {
      try { AC = new (global.AudioContext || global.webkitAudioContext)(); } catch (e) { AC = null; }
    }
    if (AC && AC.state === 'suspended') { try { AC.resume(); } catch (e) {} }
    return AC;
  }

  // 单音合成：type 波形 | f0→f1 频率扫动 | dur 时长(s) | vol 音量 | delay 延迟(s)
  function tone(type, f0, f1, dur, vol, delay) {
    if (!AC || !enabled) return;
    var t0 = AC.currentTime + (delay || 0);
    var o = AC.createOscillator(), g = AC.createGain();
    o.type = type || 'square';
    o.frequency.setValueAtTime(Math.max(1, f0), t0);
    if (f1 !== f0 && f1) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(AC.destination);
    o.start(t0); o.stop(t0 + dur + 0.03);
  }

  // 噪声爆音（爆炸质感）：低通滤波衰减
  function noise(dur, vol, cutoff, delay) {
    if (!AC || !enabled) return;
    var t0 = AC.currentTime + (delay || 0);
    var n = Math.max(1, Math.floor(AC.sampleRate * dur));
    var buf = AC.createBuffer(1, n, AC.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    var src = AC.createBufferSource(); src.buffer = buf;
    var f = AC.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = cutoff || 900;
    var g = AC.createGain(); g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f); f.connect(g); g.connect(AC.destination);
    src.start(t0);
  }

  var Audio = {
    get ctx() { return AC; },
    ensure: ensure,
    tone: tone,
    noise: noise,
    setEnabled: function (v) { enabled = !!v; if (enabled) ensure(); },
    isEnabled: function () { return enabled; },
    toggle: function () { enabled = !enabled; if (enabled) ensure(); return enabled; },
    resume: function () { if (AC && AC.state === 'suspended') { try { AC.resume(); } catch (e) {} } }
  };

  /* ============ Input：键盘状态 + 指针 / 摇杆原语 ============ */
  var keys = {};

  var Input = {
    keys: keys,

    // 统一键盘监听：
    //   opts.prevent  — 需 preventDefault 的 key 数组
    //   opts.onDown(k, e) / opts.onUp(k, e) — 游戏特定逻辑回调
    // 注意：所有按键状态写入 SharedGame.Input.keys（与游戏引用同一对象，可直接读 keys['ArrowLeft']）
    bindKeyboard: function (opts) {
      opts = opts || {};
      global.addEventListener('keydown', function (e) {
        if (opts.prevent && opts.prevent.indexOf(e.key) >= 0) e.preventDefault();
        keys[e.key] = true;
        if (opts.onDown) opts.onDown(e.key, e);
      });
      global.addEventListener('keyup', function (e) {
        keys[e.key] = false;
        if (opts.onUp) opts.onUp(e.key, e);
      });
      global.addEventListener('blur', function () { for (var k in keys) keys[k] = false; });
    },

    // 指针拖拽：handlers {down,move,up} 收到逻辑坐标 {x,y}（0..1 归一化，或游戏自定义）
    //   toLogical(e, rect) 由游戏提供 → 返回 {x,y}；缺省返回归一化坐标
    bindPointer: function (canvas, handlers, toLogical) {
      handlers = handlers || {};
      function pos(e) {
        var r = canvas.getBoundingClientRect();
        return toLogical ? toLogical(e, r) : { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
      }
      canvas.addEventListener('pointerdown', function (e) { if (handlers.down) handlers.down(pos(e), e); });
      canvas.addEventListener('pointermove', function (e) { if (handlers.move) handlers.move(pos(e), e); });
      global.addEventListener('pointerup', function (e) { if (handlers.up) handlers.up(e); });
      canvas.addEventListener('touchstart', function (e) { e.preventDefault(); }, { passive: false });
    },

    // 虚拟摇杆：返回 {active,x,y,dx,dy}（dx/dy 归一化 -1..1）；可选 onStart/onMove/onEnd
    makeStick: function (canvas, cb) {
      cb = cb || {};
      var stick = { active: false, x: 0, y: 0, dx: 0, dy: 0, id: null };
      function clamp(v) { return v < -1 ? -1 : (v > 1 ? 1 : v); }
      function start(cx, cy, src) {
        var r = canvas.getBoundingClientRect();
        stick.active = true; stick.id = src; stick.x = cx; stick.y = cy;
        stick.dx = clamp(((cx - r.left) / r.width - 0.5) * 2);
        stick.dy = clamp(((cy - r.top) / r.height - 0.5) * 2);
        if (cb.onStart) cb.onStart(stick);
      }
      function move(cx, cy) {
        if (!stick.active) return;
        var r = canvas.getBoundingClientRect();
        stick.x = cx; stick.y = cy;
        stick.dx = clamp(((cx - r.left) / r.width - 0.5) * 2);
        stick.dy = clamp(((cy - r.top) / r.height - 0.5) * 2);
        if (cb.onMove) cb.onMove(stick);
      }
      function end() { stick.active = false; stick.dx = 0; stick.dy = 0; stick.id = null; if (cb.onEnd) cb.onEnd(); }
      canvas.addEventListener('touchstart', function (e) { var t = e.touches[0]; start(t.clientX, t.clientY, 'touch'); }, { passive: false });
      canvas.addEventListener('touchmove', function (e) { e.preventDefault(); var t = e.touches[0]; move(t.clientX, t.clientY); }, { passive: false });
      canvas.addEventListener('touchend', end);
      canvas.addEventListener('touchcancel', end);
      canvas.addEventListener('mousedown', function (e) { start(e.clientX, e.clientY, 'mouse'); });
      global.addEventListener('mousemove', function (e) { if (stick.id === 'mouse') move(e.clientX, e.clientY); });
      global.addEventListener('mouseup', function () { if (stick.id === 'mouse') end(); });
      return stick;
    }
  };

  global.SharedGame = { Store: Store, Audio: Audio, Input: Input };
})(typeof window !== 'undefined' ? window : this);
