/*
 * mg-audio.js — WebAudio 兼容层（含降级）
 * ---------------------------------------------------------------
 * 本合集全部游戏的音效均为 Web Audio 程序化合成（零外部资源）。
 * 四平台中【支付宝无 WebAudio 合成能力】，因此本层必须做到：
 *   有 WebAudio  → 完整可用（与 Web 端音色一致）
 *   无 WebAudio  → 静默降级，绝不抛错打断游戏
 *
 * 平台接口差异：
 *   微信 wx.createWebAudioContext()   基础库 2.19.0+
 *   抖音 tt.getAudioContext()         基础库 1.34.0+（同步）
 *   支付宝 —— 无，仅 my.createInnerAudioContext（播文件）
 *   京东  —— 未知，探测
 *
 * 另外补齐小程序环境常见缺失：
 *   - createBuffer + getChannelData：程序化生成波形（噪声爆音）需要
 *   - resume：小游戏切后台后音频上下文会被挂起
 */
(function (global) {
  'use strict';

  var P = global.MGPlatform;
  var ctx = P.getAudioContext();
  var supported = !!ctx;

  var enabled = true;          // 静音开关
  var unlocked = false;         // 是否已通过用户手势解锁（浏览器预览需要）

  /* ============ AudioContext 补丁 ============ */

  if (supported) {
    // createBuffer：抖音文档明确列出，微信 2.19.0 也支持；
    // 部分平台仍缺失，这里做兜底实现。
    if (typeof ctx.createBuffer !== 'function') {
      ctx.createBuffer = function (channels, length, sampleRate) {
        var rate = sampleRate || ctx.sampleRate || 44100;
        var buf = { numberOfChannels: channels, length: length, sampleRate: rate,
                    duration: length / rate, _ch: [] };
        for (var c = 0; c < channels; c++) {
          var arr = new Float32Array(length);
          buf._ch.push(arr);
        }
        buf.getChannelData = function (i) { return buf._ch[i] || buf._ch[0]; };
        return buf;
      };
    }

    // resume：小游戏切后台音频上下文挂起，回来需恢复
    if (typeof ctx.resume !== 'function') {
      ctx.resume = function () { /* 不可用则忽略 */ };
    }
  }

  function resume() {
    if (!supported) return;
    try {
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        ctx.resume();
      }
    } catch (e) {}
  }

  /* ============ 合成原语 ============ */

  /**
   * 单音合成：type 波形 | f0→f1 频率扫动 | dur 时长(s) | vol 音量 | delay 延迟(s)
   * 签名与 shared.js 的 SharedGame.Audio.tone 完全一致，
   * 这样 shared.js 可以不加修改直接复用。
   */
  function tone(type, f0, f1, dur, vol, delay) {
    if (!supported || !enabled) return;
    resume();
    try {
      var t0 = ctx.currentTime + (delay || 0);
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type || 'square';
      o.frequency.setValueAtTime(Math.max(1, f0), t0);
      if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol, t0 + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g); g.connect(ctx.destination);
      o.start(t0); o.stop(t0 + dur + 0.03);
    } catch (e) {}
  }

  /**
   * 噪声爆音（爆炸质感）：低通滤波衰减。
   * 依赖 createBuffer / createBiquadFilter，缺失时静默跳过。
   */
  function noise(dur, vol, cutoff, delay) {
    if (!supported || !enabled) return;
    resume();
    try {
      if (typeof ctx.createBuffer !== 'function' ||
          typeof ctx.createBufferSource !== 'function' ||
          typeof ctx.createBiquadFilter !== 'function') return;
      var t0 = ctx.currentTime + (delay || 0);
      var rate = ctx.sampleRate || 44100;
      var n = Math.max(1, Math.floor(rate * dur));
      var buf = ctx.createBuffer(1, n, rate);
      var d = buf.getChannelData(0);
      for (var i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
      var src = ctx.createBufferSource(); src.buffer = buf;
      var f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = cutoff || 900;
      var g = ctx.createGain(); g.gain.setValueAtTime(vol, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      src.connect(f); f.connect(g); g.connect(ctx.destination);
      src.start(t0);
    } catch (e) {}
  }

  /* ============ 导出 ============ */

  var Audio = {
    /** 平台是否支持程序化合成 */
    supported: supported,
    /** 底层 AudioContext（不支持时为 null） */
    context: ctx,
    /** 底层 AudioContext 的兼容别名 */
    get ctx() { return ctx; },

    ensure: function () { resume(); return ctx; },
    resume: resume,
    tone: tone,
    noise: noise,

    setEnabled: function (v) { enabled = !!v; if (enabled) resume(); },
    isEnabled: function () { return enabled; },
    toggle: function () { enabled = !enabled; if (enabled) resume(); return enabled; },

    /**
     * 标记音频已由用户手势解锁。
     * 浏览器预览时 AudioContext 需用户交互才能出声；
     * 小游戏环境通常首次触摸即自动解锁，但仍调用此方法是安全的。
     */
    unlock: function () { unlocked = true; resume(); },
    isUnlocked: function () { return unlocked; }
  };

  global.MGAudio = Audio;

  // 【关键】注入全局 AudioContext，使游戏里 `new AudioContext()` / `window.AudioContext`
  // 这类写法（含 shared.js 的 ensure 函数）自动走本适配层，无需改游戏源码。
  if (supported) {
    global.AudioContext = function () { return ctx; };
    global.webkitAudioContext = global.AudioContext;
  } else {
    // 无 WebAudio 平台：提供空实现，让 `new AudioContext()` 不抛错。
    // 所有节点方法都是 no-op，游戏照常运行（静音）。
    var NoopNode = function () {
      this.gain = noopParam(); this.frequency = noopParam();
    };
    NoopNode.prototype.connect = function () { return this; };
    NoopNode.prototype.disconnect = function () {};
    NoopNode.prototype.start = function () {};
    NoopNode.prototype.stop = function () {};
    NoopNode.prototype.setValueAtTime = function () {};
    NoopNode.prototype.linearRampToValueAtTime = function () {};
    NoopNode.prototype.exponentialRampToValueAtTime = function () {};

    function noopParam() {
      return { value: 0, setValueAtTime: function () {}, linearRampToValueAtTime: function () {},
               exponentialRampToValueAtTime: function () {} };
    }

    global.AudioContext = function () {
      return {
        state: 'running', currentTime: 0, sampleRate: 44100,
        destination: {},
        resume: function () {},
        createOscillator: function () { return new NoopNode(); },
        createGain: function () { return new NoopNode(); },
        createBiquadFilter: function () { return new NoopNode(); },
        createBuffer: function () {
          return { getChannelData: function () { return new Float32Array(1); } };
        },
        createBufferSource: function () { return new NoopNode(); },
        createDynamicsCompressor: function () { return new NoopNode(); }
      };
    };
    global.webkitAudioContext = global.AudioContext;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
