/*
 * mg-storage.js — localStorage 兼容层
 * ---------------------------------------------------------------
 * 抹平 Web `localStorage` 与四平台 Storage API 的差异，使游戏代码零改动。
 *
 *   localStorage.getItem(k)        →  getStorageSync(k)
 *   localStorage.setItem(k, v)     →  setStorageSync(k, v)
 *   localStorage.removeItem(k)     →  removeStorageSync(k)
 *
 * 四平台均提供同步接口；异步接口作为补充暴露但默认不��。
 * 读取时对 JSON 字符串自动解析，行为与 shared.js 的 Store.get 保持一致，
 * 避免「同一份存档在 Web 和小游戏读出不同类型」的问题。
 */
(function (global) {
  'use strict';

  var P = global.MGPlatform;
  var api = P.api;
  var canSync = !!(P.caps.storage && P.caps.storage.sync);

  // 内存回退：无存储能力时（浏览器预览 / 极端环境）保证游戏逻辑不崩
  var memory = {};

  function rawGet(k) {
    if (canSync) {
      try {
        var v = api.getStorageSync(k);
        return (v === '' || v === undefined) ? null : v;
      } catch (e) { /* key 不存在时部分平台会抛错 */ }
    }
    return Object.prototype.hasOwnProperty.call(memory, k) ? memory[k] : null;
  }

  function rawSet(k, v) {
    memory[k] = v;
    if (canSync) {
      try { api.setStorageSync(k, v); } catch (e) {}
    }
  }

  function rawDel(k) {
    delete memory[k];
    if (canSync) {
      try { api.removeStorageSync(k); } catch (e) {}
    }
  }

  var Storage = {
    getItem: function (k) { return rawGet(String(k)); },

    setItem: function (k, v) { rawSet(String(k), String(v)); },

    removeItem: function (k) { rawDel(String(k)); },

    clear: function () {
      memory = {};
      if (canSync) {
        try { if (typeof api.clearStorageSync === 'function') api.clearStorageSync(); } catch (e) {}
      }
    },

    key: function (i) {
      var keys = Object.keys(memory);
      return i < keys.length ? keys[i] : null;
    },

    get length() { return Object.keys(memory).length; },

    /* ---- 以下为 shared.js Store 依赖的增强方法 ---- */

    // 读取并 JSON.parse；解析失败则原样返回字符串（兼容历史非 JSON 存档）
    getJSON: function (k, def) {
      var raw = rawGet(String(k));
      if (raw === null || raw === undefined) return def;
      try { return JSON.parse(raw); } catch (e) { return raw; }
    },

    setJSON: function (k, v) {
      try {
        rawSet(String(k), JSON.stringify(v));
        return true;
      } catch (e) { return false; }
    },

    /**
     * 异步读取。回调风格与 Web Storage 的异步用法对齐；
     * 小游戏同步接口已足够快，此处仍走 setTimeout 以保持 API 语义一致。
     */
    getAsync: function (k, cb) {
      var v = rawGet(String(k));
      if (typeof cb === 'function') setTimeout(function () { cb(v); }, 0);
    }
  };

  /**
   * 挂载到全局。
   * 浏览器预览环境下 globalThis.localStorage 是只访问器属性
   * （Window 的 [Replaceable] 槽），赋值会抛 TypeError。
   * 此时不覆盖宿主实现，只暴露 MGStorage 供显式引用。
   */
  try {
    if (typeof global.localStorage === 'undefined' ||
        typeof global.localStorage.getItem !== 'function') {
      global.localStorage = Storage;
    }
  } catch (e) {
    // 只读槽位：宿主已有原生 localStorage，沿用它即可
  }

  global.MGStorage = Storage;
})(typeof globalThis !== 'undefined' ? globalThis : this);
