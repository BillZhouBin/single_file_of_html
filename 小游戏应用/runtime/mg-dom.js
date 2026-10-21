/*
 * mg-dom.js — 迷你 DOM 与 document 兼容层
 * ---------------------------------------------------------------
 * 小游戏无 DOM，但游戏代码大量使用 DOM API。本层构造一棵虚拟 DOM，
 * 使 `document.getElementById(...)` 等调用正常工作，并把结果交给
 * mg-ui-layout + mg-ui-render 在 Canvas 上还原视觉。
 *
 * 覆盖的本合集实际用法（实测统计）：
 *   getElementById    6 ~ 35 处 / 游戏
 *   classList          108 处   → add / remove / contains / toggle
 *   textContent         69 处   → 读 / 写
 *   style               38 处   → 写 display / background / color 等
 *   addEventListener   20+ 种事件
 *   getBoundingClientRect 13 处 → 由布局引擎回填真实坐标
 *   createElement       18 处   → 动态创建 div/span/button
 *   innerHTML            8 处   → 降级为 textContent 语义
 *   offsetWidth          4 处   → 回填布局宽度
 *
 * 写操作（textContent/classList/style）会置脏标记，由 UI 层在下一帧重排重绘。
 */
(function (global) {
  'use strict';

  var L = global.MGLayout;

  /* ============ 节点模型 ============ */

  function Node(nodeType) {
    this.nodeType = nodeType;          // 1=元素 3=文本 8=注释
    this.childNodes = [];
    this.parentNode = null;
    this.parent = null;                // 布局引擎用的轻量父引用
    this._dirty = true;
  }

  function TextNode(text) {
    Node.call(this, 3);
    this.nodeValue = text;
  }
  TextNode.prototype = Object.create(Node.prototype);
  TextNode.prototype.constructor = TextNode;

  function Element(tagName) {
    Node.call(this, 1);
    this.tagName = String(tagName || 'div').toUpperCase();
    this.id = '';
    this.className = '';
    // 内联样式：普通对象 + setProperty/removeProperty，
    // 兼容游戏里 style.width='x' 与 style.setProperty(k,v) 两种写法
    this.style = makeStyleProxy();
    this.dataset = {};
    this._listeners = {};
    this._text = '';                   // element.textContent 的值
    this._box = null;
    this._style = {};
  }
  Element.prototype = Object.create(Node.prototype);
  Element.prototype.constructor = Element;

  Element.prototype.appendChild = function (child) {
    if (!child) return child;
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    child.parent = this;
    this.childNodes.push(child);
    this._dirty = true;
    this._markDirty();
    return child;
  };

  Element.prototype.removeChild = function (child) {
    var i = this.childNodes.indexOf(child);
    if (i >= 0) {
      this.childNodes.splice(i, 1);
      child.parentNode = null;
      child.parent = null;
      this._markDirty();
    }
    return child;
  };

  Element.prototype.remove = function () {
    if (this.parentNode) this.parentNode.removeChild(this);
  };

  Element.prototype.insertBefore = function (child, ref) {
    if (!ref) return this.appendChild(child);
    var i = this.childNodes.indexOf(ref);
    if (i < 0) return this.appendChild(child);
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this; child.parent = this;
    this.childNodes.splice(i, 0, child);
    this._markDirty();
    return child;
  };

  /* ---- classList ---- */

  Object.defineProperty(Element.prototype, 'classList', {
    get: function () {
      var self = this;
      return {
        add: function () {
          for (var i = 0; i < arguments.length; i++) self._addClass(arguments[i]);
          self._markDirty();
        },
        remove: function () {
          for (var i = 0; i < arguments.length; i++) self._removeClass(arguments[i]);
          self._markDirty();
        },
        toggle: function (c, force) {
          var has = self._hasClass(c);
          var want = force === undefined ? !has : !!force;
          if (want) self._addClass(c); else self._removeClass(c);
          self._markDirty();
          return want;
        },
        contains: function (c) { return self._hasClass(c); },
        replace: function (a, b) { self._removeClass(a); self._addClass(b); self._markDirty(); }
      };
    }
  });

  Element.prototype._classes = function () {
    return this.className ? String(this.className).split(/\s+/).filter(Boolean) : [];
  };
  Element.prototype._hasClass = function (c) {
    return this._classes().indexOf(c) >= 0;
  };
  Element.prototype._addClass = function (c) {
    if (!c || this._hasClass(c)) return;
    var list = this._classes();
    list.push(c);
    this.className = list.join(' ');
  };
  Element.prototype._removeClass = function (c) {
    if (!c) return;
    var list = this._classes().filter(function (x) { return x !== c; });
    this.className = list.join(' ');
  };

  /* ---- textContent / className / style ---- */

  Object.defineProperty(Element.prototype, 'textContent', {
    get: function () {
      // 语义对齐 DOM：拼接所有后代文本节点
      var out = this._text;
      for (var i = 0; i < this.childNodes.length; i++) {
        var c = this.childNodes[i];
        if (c.nodeType === 3) out += c.nodeValue;
        else if (c.nodeType === 1) out += c.textContent;
      }
      return out;
    },
    set: function (v) {
      // 写文本会清空子元素——与 DOM 一致。
      // 但本合集的 UI 里文本节点通常是唯一子节点，行为等价。
      this._text = (v === null || v === undefined) ? '' : String(v);
      this.childNodes = this.childNodes.filter(function (c) { return c.nodeType !== 3; });
      this._markDirty();
    }
  });

  // innerHTML：本合集仅用于写入纯文本与简单标签，降级为 textContent
  Object.defineProperty(Element.prototype, 'innerHTML', {
    get: function () { return this.textContent; },
    set: function (v) {
      var s = String(v == null ? '' : v);
      // 去掉标签，仅保留文本——小游戏无 HTML 解析器
      this.textContent = s.replace(/<[^>]*>/g, '');
    }
  });

  Object.defineProperty(Element.prototype, 'innerText', {
    get: function () { return this.textContent; },
    set: function (v) { this.textContent = v; }
  });

  /* ---- 几何（由布局引擎回填） ---- */

  Element.prototype.getBoundingClientRect = function () {
    // canvas 元素代理到宿主画布：宿主画布铺满全屏
    if (this._hostCanvas) {
      if (typeof this._hostCanvas.getBoundingClientRect === 'function') {
        return this._hostCanvas.getBoundingClientRect();
      }
      var s = global.MGPlatform.getScreen();
      return { left: 0, top: 0, right: s.width, bottom: s.height,
               width: s.width, height: s.height, x: 0, y: 0 };
    }
    var b = this._box;
    var sc = global.MGPlatform.getScreen();
    if (!b) {
      return { left: 0, top: 0, right: sc.width, bottom: sc.height,
               width: sc.width, height: sc.height, x: 0, y: 0 };
    }
    return { left: b.x, top: b.y, right: b.x + b.w, bottom: b.y + b.h,
             width: b.w, height: b.h, x: b.x, y: b.y };
  };

  Object.defineProperty(Element.prototype, 'offsetWidth', {
    get: function () {
      if (this._hostCanvas) {
        var s = global.MGPlatform.getScreen();
        return s.width;
      }
      return this._box ? this._box.w : 0;
    }
  });
  Object.defineProperty(Element.prototype, 'offsetHeight', {
    get: function () {
      if (this._hostCanvas) {
        var s = global.MGPlatform.getScreen();
        return s.height;
      }
      return this._box ? this._box.h : 0;
    }
  });
  Object.defineProperty(Element.prototype, 'clientWidth', {
    get: function () { return this._contentW !== undefined ? this._contentW : (this._box ? this._box.w : 0); }
  });
  Object.defineProperty(Element.prototype, 'clientHeight', {
    get: function () { return this._contentH !== undefined ? this._contentH : (this._box ? this._box.h : 0); }
  });

  /* ---- 事件 ---- */

  Element.prototype.addEventListener = function (type, fn) {
    if (!fn) return;
    (this._listeners[type] || (this._listeners[type] = [])).push(fn);
    // 转发到全局输入层，便于统一命中测试
    if (global.MGInput) global.MGInput.addEventListener('canvas', type, fn);
  };
  Element.prototype.removeEventListener = function (type, fn) {
    var arr = this._listeners[type];
    if (!arr) return;
    var i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
    if (global.MGInput) global.MGInput.removeEventListener('canvas', type, fn);
  };
  Element.prototype.dispatchEvent = function (evt) {
    var arr = this._listeners[evt && evt.type];
    if (arr) arr.slice().forEach(function (fn) { try { fn(evt); } catch (e) {} });
    return true;
  };

  Element.prototype.focus = function () {};
  Element.prototype.blur  = function () {};

  Element.prototype.getParentNode = function () { return this.parentNode; };
  Object.defineProperty(Element.prototype, 'parentElement', {
    get: function () { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
  });
  Object.defineProperty(Element.prototype, 'firstElementChild', {
    get: function () {
      for (var i = 0; i < this.childNodes.length; i++) {
        if (this.childNodes[i].nodeType === 1) return this.childNodes[i];
      }
      return null;
    }
  });
  Object.defineProperty(Element.prototype, 'children', {
    get: function () {
      return this.childNodes.filter(function (c) { return c.nodeType === 1; });
    }
  });

  /**
   * canvas 元素代理。
   *
   * 小游戏没有 <canvas> 标签，绘图必须落到宿主画布上。本合集游戏的取画布方式
   * 有三种，全部要支持：
   *   1. document.getElementById('c').getContext('2d')   —— 显式 <canvas id="c">
   *   2. document.getElementById('game').getContext('2d') —— div 容器当画布用
   *      （hot-air-balloon 就是这种：#game 是布局容器，代码却直接在其上取 ctx）
   *   3. document.createElement('canvas')                  —— 离屏预渲染
   *
   * 处理方式：虚拟节点持有 _hostCanvas 并把绘图 API 转发过去。
   */
  function bindHostCanvas(el, hostCanvas) {
    el._hostCanvas = hostCanvas;
    el._isCanvas = true;
    el.getContext = function (type) {
      var c = hostCanvas.getContext(type);
      // 每个上下文都补齐缺失 API（含 drawImage 解包），不依赖调用时机
      if (global.MGCanvas && global.MGCanvas.patchContext) {
        try { global.MGCanvas.patchContext(c); } catch (e) {}
      }
      return c;
    };
    el.toDataURL = function () { return hostCanvas.toDataURL ? hostCanvas.toDataURL() : ''; };
    // width/height 需要透传：游戏常写 cv.width = W 直接改变后备缓冲
    if (hostCanvas.width !== undefined) {
      try {
        Object.defineProperty(el, 'width', {
          get: function () { return hostCanvas.width; },
          set: function (v) { hostCanvas.width = v; },
          configurable: true
        });
        Object.defineProperty(el, 'height', {
          get: function () { return hostCanvas.height; },
          set: function (v) { hostCanvas.height = v; },
          configurable: true
        });
      } catch (e) { /* 宿主画布不允许重定义时忽略 */ }
    }
    return el;
  }

  /** 判断节点是否应绑定宿主画布（标签为 canvas，或 id 常见命名） */
  function shouldBindCanvas(el) {
    if (el.tagName === 'CANVAS') return true;
    // 部分游戏用 div 当容器再 querySelector('canvas')，此时真实画布仍由 id 定位
    return false;
  }
  Element.prototype.setAttribute = function (k, v) {
    if (k === 'class') this.className = v;
    else if (k === 'id') this.id = v;
    else if (k === 'style') { var st = String(v).split(';'); for (var i = 0; i < st.length; i++) {
      var kv = st[i].split(':'); if (kv[0] && kv[1]) this.style[kv[0].trim()] = kv[1].trim();
    } }
    else this[k] = v;
    this._markDirty();
  };
  Element.prototype.getAttribute = function (k) {
    if (k === 'class') return this.className;
    if (k === 'id') return this.id;
    return this[k];
  };

  /* ---- 查询 ---- */

  Element.prototype.querySelector = function (sel) {
    var r = queryAll(this, sel);
    return r.length ? r[0] : null;
  };
  Element.prototype.querySelectorAll = function (sel) { return queryAll(this, sel); };
  Element.prototype.getElementsByClassName = function (c) {
    return queryAll(this, '.' + c);
  };
  Element.prototype.getElementById = function (id) { return findById(this, id); };

  function queryAll(root, sel) {
    var out = [];
    var sels = String(sel).split(',').map(function (s) { return s.trim(); });
    (function walk(n) {
      var kids = n.childNodes || [];
      for (var i = 0; i < kids.length; i++) {
        var c = kids[i];
        if (c.nodeType !== 1) continue;
        for (var k = 0; k < sels.length; k++) {
          if (matchSimpleNode(c, sels[k])) { out.push(c); break; }
        }
        walk(c);
      }
    })(root);
    return out;
  }

  function matchSimpleNode(node, sel) {
    var m = String(sel).trim().match(/^([a-zA-Z][\w-]*)?((?:[.#][\w-]+)*)$/);
    if (!m) return false;
    if (m[1] && node.tagName.toLowerCase() !== m[1].toLowerCase()) return false;
    var tokens = (m[2] || '').match(/[.#][\w-]+/g) || [];
    for (var i = 0; i < tokens.length; i++) {
      if (tokens[i].charAt(0) === '.') { if (!node._hasClass(tokens[i].slice(1))) return false; }
      else if (node.id !== tokens[i].slice(1)) return false;
    }
    return true;
  }

  function findById(root, id) {
    var found = null;
    (function walk(n) {
      if (found) return;
      var kids = n.childNodes || [];
      for (var i = 0; i < kids.length; i++) {
        var c = kids[i];
        if (c.nodeType !== 1) continue;
        if (c.id === id) { found = c; return; }
        walk(c);
        if (found) return;
      }
    })(root);
    return found;
  }

  /* ---- 脏标记 ---- */

  Element.prototype._markDirty = function () {
    this._dirty = true;
    // 向上传播：任一后代变化都会影响整棵树布局
    var p = this.parentNode;
    while (p) { p._dirty = true; p = p.parentNode; }
  };

  /* ============ document ============ */

  var documentRoot = new Element('body');
  documentRoot.id = 'body';

  var byId = {};

  /**
   * 建立 id 索引，并把树中的 <canvas> 绑定到宿主画布。
   * 绑定必须在索引建立【之后】，且只对第一个 canvas 生效——
   * 小游戏上屏画布只有一块，多个 canvas 需走离屏（本合集实测每游戏仅 1 个 canvas）。
   */
  function registerTree(node) {
    (function walk(n) {
      if (n.nodeType !== 1) return;
      if (n.id) byId[n.id] = n;
      (n.childNodes || []).forEach(walk);
    })(node);

    // 绑定 canvas：取第一个 canvas 元素接到宿主主画布上
    var firstCanvas = null;
    (function find(n) {
      if (firstCanvas) return;
      if (n.nodeType !== 1) return;
      if (shouldBindCanvas(n)) { firstCanvas = n; return; }
      (n.childNodes || []).forEach(find);
    })(node);

    if (firstCanvas && global.MGCanvas) {
      var host = global.MGCanvas.getMain();
      if (!host) {
        // 宿主画布尚未创建（游戏在挂载后才取画布）：这里主动创建上屏画布
        host = global.MGCanvas.create(false);
      }
      if (host) {
        bindHostCanvas(firstCanvas, host);
        ensureCanvasMethods(host);
      }
    }
  }

  /**
   * 为宿主画布补齐 DOM Canvas 元素才有的方法。
   * 小游戏画布只有绘图能力，缺 getBoundingClientRect / addEventListener，
   * 游戏代码常直接用它们做命中测试与事件绑定。
   */
  function ensureCanvasMethods(host) {
    if (typeof host.addEventListener !== 'function') {
      host.addEventListener = function (type, fn) {
        if (global.MGInput) global.MGInput.addEventListener('canvas', type, fn);
      };
      host.removeEventListener = function (type, fn) {
        if (global.MGInput) global.MGInput.removeEventListener('canvas', type, fn);
      };
    }
    if (typeof host.getBoundingClientRect !== 'function') {
      host.getBoundingClientRect = function () {
        var s = global.MGPlatform.getScreen();
        return { left: 0, top: 0, right: s.width, bottom: s.height,
                 width: s.width, height: s.height, x: 0, y: 0 };
      };
    }
    if (typeof host.style === 'undefined') {
      host.style = makeStyleProxy();
    }
  }

  /**
   * 最小 style 代理：支持 `style.width = '10px'` 赋值，
   * 以及游戏里出现的 `style.setProperty(k, v)` 写法（mixed-mode 用了）。
   */
  function makeStyleProxy() {
    var store = {};
    return {
      setProperty: function (k, v) { store[k] = v; },
      getPropertyValue: function (k) { return store[k] === undefined ? '' : store[k]; },
      removeProperty: function (k) { delete store[k]; },
      _store: store
    };
  }

  var document = {
    nodeType: 9,
    documentElement: documentRoot,
    body: documentRoot,
    head: (function () { var h = new Element('head'); return h; })(),
    createElement: function (tag) {
      var el = new Element(tag);
      // 【关键】动态创建的 canvas 必须立即绑定宿主画布。
      // 本合集多款游戏用 document.createElement('canvas') 做离屏预渲染
      // （精灵烘焙），若不绑定则 getContext 为 undefined 直接崩溃。
      if (String(tag).toLowerCase() === 'canvas' && global.MGCanvas) {
        var host = global.MGCanvas.createOffscreen();
        if (host) {
          bindHostCanvas(el, host);
          ensureCanvasMethods(host);
        }
      }
      return el;
    },
    createTextNode: function (t) { return new TextNode(t); },
    getElementById: function (id) {
      var k = String(id);
      var el = byId[k] || findById(documentRoot, k);
      if (!el) return null;
      // 【兜底】元素未显式绑定画布时，按需补一个 getContext 代理。
      // 覆盖「div 容器被当作画布使用」的写法（hot-air-balloon: #game）。
      // 上屏画布只有一块，因此已绑定的优先复用，未绑定的取主画布。
      if (typeof el.getContext !== 'function' && global.MGCanvas) {
        var host = el._hostCanvas || global.MGCanvas.getMain() || global.MGCanvas.create(false);
        if (host) {
          bindHostCanvas(el, host);
          ensureCanvasMethods(host);
        }
      }
      return el;
    },
    querySelector: function (s) { return queryAll(documentRoot, s)[0] || null; },
    querySelectorAll: function (s) { return queryAll(documentRoot, s); },
    getElementsByClassName: function (c) { return queryAll(documentRoot, '.' + c); },
    getElementsByTagName: function (t) {
      return queryAll(documentRoot, String(t).toLowerCase());
    },
    addEventListener: function (type, fn) {
      if (global.MGInput) global.MGInput.addEventListener('window', type, fn);
    },
    removeEventListener: function (type, fn) {
      if (global.MGInput) global.MGInput.removeEventListener('window', type, fn);
    },
    /** 供构建期注入解析好的 DOM 树 */
    _setTree: function (rootNode) {
      documentRoot = rootNode;
      byId = {};
      registerTree(documentRoot);
    },
    _root: function () { return documentRoot; },
    _reindex: function () { byId = {}; registerTree(documentRoot); }
  };

  /* ============ window ============ */

  var screen = global.MGPlatform.getScreen();

  var win = {
    innerWidth: screen.width,
    innerHeight: screen.height,
    devicePixelRatio: screen.pixelRatio,
    navigator: {
      userAgent: 'MG/' + global.MGPlatform.id,
      platform: global.MGPlatform.id,
      vibrate: global.MGPlatform.vibrate
    },
    screen: { width: screen.width, height: screen.height },
    location: { search: '', hash: '', href: '' },
    performance: global.performance || { now: function () { return Date.now(); } },
    addEventListener: function (type, fn) {
      if (global.MGInput) global.MGInput.addEventListener('window', type, fn);
    },
    removeEventListener: function (type, fn) {
      if (global.MGInput) global.MGInput.removeEventListener('window', type, fn);
    },
    matchMedia: function (q) {
      // 无媒体查询能力：prefers-reduced-motion 一律返回 false（保持动效）
      return { matches: false, media: q, addListener: function () {}, removeListener: function () {} };
    },
    setTimeout: function (fn, ms) { return setTimeout(fn, ms); },
    clearTimeout: function (id) { return clearTimeout(id); },
    setInterval: function (fn, ms) { return setInterval(fn, ms); },
    clearInterval: function (id) { return clearInterval(id); },
    requestAnimationFrame: function (cb) {
      return global.requestAnimationFrame
        ? global.requestAnimationFrame(cb)
        : setTimeout(function () { cb(Date.now()); }, 16);
    },
    cancelAnimationFrame: function (id) {
      if (global.cancelAnimationFrame) global.cancelAnimationFrame(id);
      else clearTimeout(id);
    },
    atob: global.atob || function (s) { return s; },
    btoa: global.btoa || function (s) { return s; },
    alert: function (msg) { try { global.MGPlatform.api.alert({ content: msg }); } catch (e) {} },
    getComputedStyle: function (node) { return node._style || {}; },
    scrollTo: function () {},
    open: function () {}
  };

  /* ============ 注入全局 ============ */
  /*
   * 说明：小游戏宿主无 DOM，浏览器预览时我们同样注入虚拟 DOM，
   * 以保证「预览看到的」与「真机跑的」是同一套布局代码——
   * 否则预览走原生 DOM、真机走 Canvas 引擎，会出现两套渲染结果。
   */

  global.MGElement = Element;
  global.MGTextNode = TextNode;
  global.MGDocument = document;
  global.MGWindow = win;

  /**
   * 全局挂载。
   * 【注意】浏览器预览环境下 document / window / navigator / localStorage
   * 都是 Window 上的只访问器属性（[Replaceable] 槽），直接赋值会抛
   * TypeError: "Cannot set property X of which has only a getter"。
   * 因此统一用 safeAssign：能覆盖就覆盖（小游戏环境需要），
   * 覆盖失败则保留宿主实现，并通过 MGDocument / MGWindow 等符号访问。
   */
  function safeAssign(name, value) {
    try {
      global[name] = value;
      return true;
    } catch (e) {
      return false;   // 宿主为只读槽位
    }
  }
  var isReplaced = {
    document: safeAssign('document', document),
    window:   safeAssign('window', win),
    navigator: safeAssign('navigator', win.navigator)
  };

  // 覆盖失败时（浏览器预览）：让 window.document 指向虚拟 DOM，
  // 保证 getElementById 等调用打到适配层而非原生 document。
  if (!isReplaced.document) {
    try { win.document = document; } catch (e) {}
  }

  /**
   * localStorage 挂载。
   * 【注意】浏览器预览环境下 globalThis.localStorage 是只访问器属性
   * （Window 的 [Replaceable] 槽），直接赋值会抛 TypeError:
   * "Cannot set property localStorage of which has only a getter"。
   * 因此必须先探测「当前值是否已是我们要的适配层实现」，只在必要时替换。
   */
  (function mountStorage() {
    var existing = global.localStorage;
    var ours = global.MGStorage;
    if (existing === ours) return;                 // 已是适配层，无需处理
    if (existing && typeof existing.getItem === 'function' &&
        typeof existing.setItem === 'function') {
      // 宿主自带可用实现（如浏览器预览）：直接沿用，不强行覆盖。
      // 浏览器预览下本就该用原生 localStorage——真机验证交给开发者工具。
      global.MGStorageHostProvided = true;
      return;
    }
    try { global.localStorage = ours; }
    catch (e) { /* 只读槽位且无可用实现：MGStorage 仍可被显式引用 */ }
  })();

  /**
   * Image 兼容。
   * 小游戏无 <img>，位图需走平台接口。本合集仅 chrome-dino 使用 Image
   * （且是内联 data URI），因此这里用平台 createImage 或 no-op 占位，
   * 保证 `new Image()` 与 `.src =` 不抛错；解码回调在无位图能力时永不触发。
   */
  if (typeof global.Image === 'undefined') {
    var P2 = global.MGPlatform;
    global.Image = function () {
      var self = this;
      this.width = 0; this.height = 0; this.complete = false;
      this._src = '';
      var nativeImg = null;
      try {
        if (P2.api && typeof P2.api.createImage === 'function') {
          nativeImg = P2.api.createImage();
        }
      } catch (e) { nativeImg = null; }

      Object.defineProperty(this, 'src', {
        get: function () { return self._src; },
        set: function (v) {
          self._src = v;
          if (nativeImg) {
            nativeImg.onload = function () {
              self.width = nativeImg.width; self.height = nativeImg.height;
              self.complete = true;
              if (typeof self.onload === 'function') self.onload();
            };
            nativeImg.onerror = function () {
              if (typeof self.onerror === 'function') self.onerror();
            };
            nativeImg.src = v;
          } else {
            // 无位图能力：标记完成但不回调 onload，避免游戏卡在等待状态
            self.complete = true;
          }
        }
      });
    };
  }

  /**
   * SharedGame 兜底。
   * shared.js 会被构建期内联，它以 `typeof window !== 'undefined' ? window : this`
   * 决定挂载目标。小游戏里 window 存在，因此挂到 win 上；
   * 而游戏代码用裸标识符 SharedGame 访问的是 globalThis。
   * 这里做双向同步，保证两条路径拿到同一个对象。
   */
  function syncSharedGame() {
    var fromWin = win.SharedGame;
    var fromGlobal = global.SharedGame;
    if (fromWin && fromGlobal && fromWin !== fromGlobal) {
      // 两边都有（内联的 shared.js 挂了 win，兜底逻辑挂了 global）：以 shared.js 为准
      global.SharedGame = fromWin;
    } else if (fromWin && !fromGlobal) {
      global.SharedGame = fromWin;
    } else if (fromGlobal && !fromWin) {
      win.SharedGame = fromGlobal;
    } else if (!fromWin && !fromGlobal) {
      var impl = {
        Store: {
          get: function (k, def) {
            try { var v = global.localStorage.getItem(k); return v === null ? def : v; }
            catch (e) { return def; }
          },
          set: function (k, v) {
            try { global.localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)); return true; }
            catch (e) { return false; }
          },
          del: function (k) { try { global.localStorage.removeItem(k); } catch (e) {} },
          getJSON: function (k, def) {
            try {
              var v = global.localStorage.getItem(k);
              return v === null ? def : JSON.parse(v);
            } catch (e) { return def; }
          },
          setJSON: function (k, v) { return this.set(k, v); }
        },
        Audio: global.MGAudio,
        Input: global.MGInput
      };
      global.SharedGame = impl;
      win.SharedGame = impl;
    }
  }
  syncSharedGame();

  /* ============ UI 帧驱动 ============ */

  var layoutEngine = new L.LayoutEngine();
  var renderer = new global.MGUIRender.Renderer();

  var UI = {
    /** 由构建期注入：把 HTML <body> 解析为虚拟 DOM 并挂载 */
    mount: function (htmlString, cssText) {
      var root = global.MGParser.parseBody(htmlString);
      document._setTree(root);
      if (cssText) {
        layoutEngine.setSheet(global.MGParser.parseCss(cssText));
      }
      return root;
    },

    setSheet: function (cssText) {
      layoutEngine.setSheet(global.MGParser.parseCss(cssText));
    },

    /** 每帧调用：脏则重排，随后绘制 */
    render: function (ctx) {
      var root = document._root();
      if (root._dirty) {
        layoutEngine.setRoot(root);
        layoutEngine.run();
        markClean(root);
      }
      renderer.render(ctx, root);
    },

    /** 强制重排（resize / 横竖屏切换后） */
    invalidate: function () {
      var root = document._root();
      if (root) root._markDirty();
      layoutEngine.setRoot(root);
      layoutEngine.run();
      if (root) markClean(root);
    },

    setDebug: function (on) { renderer.debug = !!on; },

    /** 命中测试：按 z-index 从高到低找第一个命中的可交互元素 */
    hitTest: function (x, y) {
      var root = document._root();
      var nodes = [];
      (function collect(n) {
        if (n.nodeType !== 1 || !n._box) return;
        if (n._style && n._style.display === 'none') return;
        nodes.push(n);
        (n.childNodes || []).forEach(collect);
      })(root);
      nodes.sort(function (a, b) {
        return (parseInt(b._style && b._style['z-index'], 10) || 0) -
               (parseInt(a._style && a._style['z-index'], 10) || 0);
      });
      for (var i = 0; i < nodes.length; i++) {
        var b = nodes[i]._box;
        if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
          if (nodes[i]._listeners && hasPointerHandler(nodes[i])) return nodes[i];
        }
      }
      return null;
    },

    getRenderer: function () { return renderer; },
    getEngine: function () { return layoutEngine; }
  };

  function hasPointerHandler(el) {
    var l = el._listeners;
    if (!l) return false;
    return !!(l.click || l.pointerdown || l.touchstart || l.mousedown || l.tap);
  }

  function markClean(node) {
    node._dirty = false;
    (node.childNodes || []).forEach(function (c) { if (c.nodeType === 1) markClean(c); });
  }

  global.MGUI = UI;
})(typeof globalThis !== 'undefined' ? globalThis : this);
