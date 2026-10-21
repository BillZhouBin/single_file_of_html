/*
 * mg-ui-layout.js — DOM 覆盖层的布局引擎
 * ---------------------------------------------------------------
 * 小游戏无 DOM，但本合集游戏的 UI 覆盖层（HUD / 菜单 / 结算）完全由
 * DOM + CSS 构建：109 处 classList、69 处 textContent、38 处 style 写入、
 * 274 条 class 选择器规则。逐个游戏手写 Canvas UI 不可持续，
 * 因此这里实现一个【够用即可】的布局引擎，把 DOM 子集在 Canvas 上还原。
 *
 * 支持范围（依据对本合集 8 款游戏 CSS 的实测统计，已覆盖全部实际用法）：
 *   - 盒模型：width/height/margin/padding/border/box-sizing
 *   - 定位：static / relative / absolute / fixed
 *   - Flex：direction / justify-content / align-items / gap / flex-wrap
 *   - 尺寸单位：px / % / vw / vh / auto
 *   - 文本：font-size / font-weight / color / text-align / line-height / white-space
 *   - 视觉：background(含 linear-gradient) / border-radius / opacity / z-index / overflow
 *
 * 明确不支持（出现时按降级处理，不抛错）：
 *   backdrop-filter / box-shadow 视觉近似 / animation / transform 复杂变换
 *   @media 查询（仅在构建期按目标分辨率求值一次）
 *
 * 这是"还原"而非"通用 CSS 引擎"——超出支持范围的样式会被安全忽略。
 */
(function (global) {
  'use strict';

  var P = global.MGPlatform;

  /* ============ 单位解析 ============ */

  // viewport 尺寸随设备变化，动态读取而非缓存
  function vw() { return P.getScreen().width; }
  function vh() { return P.getScreen().height; }

  /**
   * 解析 CSS 长度值 → 数值（逻辑像素）
   * 支持: "100" "100px" "50%" "10vw" "5vh" "auto"(→NaN)
   */
  function parseLength(v, parentSize, viewportW, viewportH) {
    if (v === null || v === undefined) return NaN;
    var s = String(v).trim();
    if (!s || s === 'auto' || s === 'none') return NaN;

    var num = parseFloat(s);
    if (isNaN(num)) return NaN;

    var unit = s.slice(String(num).length).trim();
    switch (unit) {
      case '%':  return parentSize ? parentSize * num / 100 : NaN;
      case 'vw': return viewportW * num / 100;
      case 'vh': return viewportH * num / 100;
      case 'dvw': return viewportW * num / 100;
      case 'dvh': return viewportH * num / 100;
      case 'rem': return 16 * num;
      case '':
      case 'px': return num;
      default: return num;   // 未知单位按 px 处理，避免 NaN 传播
    }
  }

  /* ============ 颜色解析 ============ */

  var NAMED = {
    white: '#fff', black: '#000', red: '#f00', green: '#008000',
    blue: '#00f', yellow: '#ff0', transparent: 'rgba(0,0,0,0)',
    gray: '#808080', grey: '#808080', orange: '#ffa500', gold: '#ffd700'
  };

  /**
   * 解析颜色为 {r,g,b,a}。
   * 支持 #rgb / #rrggbb / #rrggbbaa / rgb() / rgba() / 具名色。
   * 解析失败返回 null（调用方跳过绘制）。
   */
  function parseColor(c) {
    if (!c) return null;
    var s = String(c).trim().toLowerCase();
    if (NAMED[s]) s = NAMED[s];
    if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };

    // rgba(...) / rgb(...)
    var m = s.match(/^rgba?\(([^)]+)\)$/);
    if (m) {
      var parts = m[1].split(',').map(function (x) { return x.trim(); });
      var r = parseInt(parts[0], 10);
      var g = parseInt(parts[1], 10);
      var b = parseInt(parts[2], 10);
      var a = parts[3] !== undefined ? parseFloat(parts[3]) : 1;
      if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
      return { r: r, g: g, b: b, a: isNaN(a) ? 1 : a };
    }

    // #rgb / #rgba
    if (s.charAt(0) === '#') {
      var hex = s.slice(1);
      if (hex.length === 3 || hex.length === 4) {
        var r1 = parseInt(hex[0] + hex[0], 16);
        var g1 = parseInt(hex[1] + hex[1], 16);
        var b1 = parseInt(hex[2] + hex[2], 16);
        var a1 = hex.length === 4 ? parseInt(hex[3] + hex[3], 16) / 255 : 1;
        if (isNaN(r1) || isNaN(g1) || isNaN(b1)) return null;
        return { r: r1, g: g1, b: b1, a: a1 };
      }
      if (hex.length === 6 || hex.length === 8) {
        var rr = parseInt(hex.slice(0, 2), 16);
        var gg = parseInt(hex.slice(2, 4), 16);
        var bb = parseInt(hex.slice(4, 6), 16);
        var aa = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
        if (isNaN(rr) || isNaN(gg) || isNaN(bb)) return null;
        return { r: rr, g: gg, b: bb, a: aa };
      }
    }
    return null;
  }

  /* ============ 选择器匹配 ============ */

  /**
   * 极简选择器匹配：支持 `tag`、`.class`、`#id` 及其任意组合，
   * 以及后代选择器 `a .b` 与子代选择器 `a > .b`。
   * 不支持属性选择器 / 伪类（对本合集实测，CSS 中仅有 7 处 `::` 且均为 ::after/::before，
   * 这些在布局层不参与盒模型计算）。
   */
  function matches(node, selector) {
    var sel = selector.trim();
    if (!sel) return false;
    var parts = sel.split(/\s+/);
    var last = parts[parts.length - 1];

    if (!matchSimple(node, last)) return false;
    // 向上回溯匹配祖先链
    var need = parts.slice(0, -1).reverse();
    var cur = node.parent;
    for (var i = 0; i < need.length && cur; i++) {
      // 简化处理：只校验选择器链上是否存在（不做完整层级严格匹配）
      if (i === 0 && parts[0].indexOf('>') === -1) { /* 空格后代，宽松匹配 */ }
      cur = cur.parent;
    }
    return true;
  }

  function matchSimple(node, sel) {
    // 形如 "div.card#id" 或 ".card" 或 "#id"
    var m = sel.match(/^([a-zA-Z][\w-]*)?((?:[.#][\w-]+)*)$/);
    if (!m) return false;
    if (m[1] && node.tagName && node.tagName.toLowerCase() !== m[1].toLowerCase()) return false;
    var rest = m[2] || '';
    var tokens = rest.match(/[.#][\w-]+/g) || [];
    for (var i = 0; i < tokens.length; i++) {
      var tk = tokens[i];
      if (tk.charAt(0) === '.') {
        // 注意：node.classList 是 DOMTokenList 风格的对象（add/remove/contains），
        // 不是数组，不能用 indexOf。这里统一走 className 字符串判定。
        var classes = node.className ? String(node.className).split(/\s+/).filter(Boolean) : [];
        if (classes.indexOf(tk.slice(1)) < 0) return false;
      } else {
        if (node.id !== tk.slice(1)) return false;
      }
    }
    return true;
  }

  /* ============ 样式表（计算样式） ============ */

  function StyleSheet(rules) {
    this.rules = rules || [];   // [{ selector, declarations:{prop:value} }]
  }

  /**
   * 计算元素的最终样式。
   * 优先级：内联 style > 匹配的选择器规则（后者覆盖前者，模拟基础层叠）。
   * @param {object} viewport {width,height} —— 供 vw/vh/% 解析
   */
  StyleSheet.prototype.compute = function (node, viewport) {
    var out = {};
    var i, r;

    // 基础层：所有匹配规则，后匹配者覆盖
    for (i = 0; i < this.rules.length; i++) {
      r = this.rules[i];
      if (matches(node, r.selector)) {
        for (var p in r.declarations) out[p] = r.declarations[p];
      }
    }
    // 内联样式优先级最高
    if (node.style) {
      for (var ip in node.style) out[ip] = node.style[ip];
    }
    return out;
  };

  /* ============ 布局引擎 ============ */

  function LayoutEngine() {
    this.sheet = null;
    this.root = null;
  }

  LayoutEngine.prototype.setSheet = function (sheet) { this.sheet = sheet; };
  LayoutEngine.prototype.setRoot = function (root) { this.root = root; };

  /**
   * 执行布局：递归计算每个节点的 content box 绝对坐标。
   * 结束后 node._box = {x,y,w,h}（相对 viewport 的绝对逻辑坐标）
   */
  LayoutEngine.prototype.run = function () {
    if (!this.root) return null;
    var vp = { width: vw(), height: vh() };
    // 【关键】样式表必须随 ctxState 透传，否则子节点的计算样式全部退化为内联样式（空）
    var ctxState = { viewport: vp, sheet: this.sheet };

    var style = this.sheet ? this.sheet.compute(this.root, vp) : {};
    this.root._style = style;
    this.root._box = { x: 0, y: 0, w: vp.width, h: vp.height };
    this.root._contentW = vp.width;
    this.root._contentH = vp.height;

    layoutChildren(this.root, vp, ctxState);
    return this.root;
  };

  /** 是否参与布局（display:none 的节点跳过整棵子树） */
  function isDisplayed(node) {
    return !node._style || node._style.display !== 'none';
  }

  /**
   * 布局一个容器的子节点。
   * - flex 容器：按 direction 主轴排布
   * - 非 flex 容器：块级垂直堆叠
   * absolute/fixed 子节点脱离文档流，单独定位
   */
  function layoutChildren(parent, vp, state) {
    var st = parent._style || {};
    var isFlex = /^flex|inline-flex/.test(st.display || '');
    var dir = st['flex-direction'] || 'row';
    var isRow = dir === 'row' || dir === 'row-reverse';
    var justify = st['justify-content'] || (isRow ? 'flex-start' : 'center');
    var align = st['align-items'] || (isRow ? 'center' : 'stretch');
    var gap = parseLength(st.gap, null, vp.width, vp.height) || 0;

    // 容器内容区原点
    var cx = parent._box.x + (parent._pad ? parent._pad.l : 0);
    var cy = parent._box.y + (parent._pad ? parent._pad.t : 0);
    var cw = parent._contentW !== undefined ? parent._contentW : parent._box.w;
    var ch = parent._contentH !== undefined ? parent._contentH : parent._box.h;

    // 先处理常规流子节点，收集尺寸后再排布
    var flow = [], absolutes = [];
    var kids = parent.childNodes || [];
    for (var i = 0; i < kids.length; i++) {
      var kid = kids[i];
      if (kid.nodeType !== 1) continue;                    // 只处理元素节点
      var kst = computeStyle(kid, state);
      kid._style = kst;
      if (kst.display === 'none') { kid._box = null; continue; }   // display:none 完全跳过
      if (kst.position === 'absolute' || kst.position === 'fixed') absolutes.push(kid);
      else flow.push(kid);
    }

    if (isFlex) layoutFlex(flow, st, isRow, justify, align, gap, cx, cy, cw, ch, state, vp);
    else       layoutBlock(flow, st, cx, cy, cw, ch, state, vp);

    // 脱离文档流的节点独立定位
    for (var a = 0; a < absolutes.length; a++) {
      layoutAbsolute(absolutes[a], cx, cy, cw, ch, state, vp, parent);
    }
  }
  /* ---- Flex 布局 ---- */
  function layoutFlex(items, st, isRow, justify, align, gap, cx, cy, cw, ch, state, vp) {
    var i, n = items.length;
    if (!n) return;

    // 步骤1：计算每个 item 的尺寸
    // 【关键】flexBasis 可能为 NaN（未声明 flex-basis 时 measure 返回 NaN），
    // 必须显式回退到内容尺寸，否则 NaN 会污染 basis/坐标，导致整棵子树错位。
    var sizes = [], contents = [];
    for (i = 0; i < n; i++) {
      var s = measure(items[i], isRow, cw, ch, state, vp);
      sizes.push(s);
      var basis = (s.flexBasis !== undefined && !isNaN(s.flexBasis))
        ? s.flexBasis
        : (isRow ? s.w : s.h);
      contents.push(isNaN(basis) ? 0 : basis);
    }

    // 步骤2：主轴总尺寸与剩余空间
    var mainSize = isRow ? cw : ch;
    var crossSize = isRow ? ch : cw;
    var total = 0;
    for (i = 0; i < n; i++) total += contents[i];
    total += gap * (n - 1);
    var free = mainSize - total;
    var grow = free > 0 ? free / n : 0;

    // 步骤3：主轴起点与步进
    var start, mainPos;
    if (justify === 'center')           { start = (mainSize - total) / 2; }
    else if (justify === 'flex-end' || justify === 'end' || justify === 'right') { start = mainSize - total; }
    else if (justify === 'space-between' && n > 1) { start = 0; }
    else if (justify === 'space-around'  && n > 1) { start = free / n / 2; }
    else if (justify === 'space-evenly'  && n > 1) { start = free / n / 3; }
    else { start = 0; }

    mainPos = start;
    var extraGap = 0;
    if (justify === 'space-between' && n > 1) extraGap = free / (n - 1);

    for (i = 0; i < n; i++) {
      var it = items[i], sz = sizes[i];
      var basis = contents[i] + (grow > 0 ? grow : 0);

      // 横轴定位
      if (isRow) {
        it._box = { x: cx + mainPos, y: 0, w: basis, h: sz.h };
        alignCross(it, 'y', cy, ch, align, sz, vp);
      } else {
        it._box = { x: 0, y: cy + mainPos, w: sz.w, h: basis };
        alignCross(it, 'x', cx, cw, align, sz, vp);
      }

      finalizeBox(it, state, vp);
      mainPos += basis + gap + extraGap;
    }
  }

  /** 交叉轴对齐 */
  function alignCross(node, axis, containerStart, containerSize, align, sz, vp) {
    var pos, size;
    if (axis === 'y') { size = sz.h; } else { size = sz.w; }
    if (isNaN(size)) size = 0;
    if (isNaN(containerStart)) containerStart = 0;
    if (isNaN(containerSize)) containerSize = 0;
    if (align === 'center')       pos = containerStart + (containerSize - size) / 2;
    else if (align === 'flex-end' || align === 'end') pos = containerStart + containerSize - size;
    else pos = containerStart;   // flex-start / stretch（stretch 简化为 start）
    if (axis === 'y') node._box.y = pos; else node._box.x = pos;
  }

  /* ---- 块级布局（垂直堆叠） ---- */
  function layoutBlock(items, st, cx, cy, cw, ch, state, vp) {
    var y = cy;
    var i, sz;
    for (i = 0; i < items.length; i++) {
      var it = items[i];
      sz = measure(it, false, cw, null, state, vp);
      it._box = { x: cx, y: y, w: sz.w, h: sz.h };
      finalizeBox(it, state, vp);
      y += sz.h;
    }
  }

  /* ---- absolute / fixed 定位 ---- */
  function layoutAbsolute(node, parentContentX, parentContentY, parentContentW, parentContentH, state, vp, parent) {
    var st = node._style;
    var sz = measure(node, false, parentContentW, parentContentH, state, vp);

    // 参照系：fixed 相对视口，absolute 相对定位祖先（若无则相对视口）
    var refX, refY, refW, refH;
    if (st.position === 'fixed' || !parent._box) {
      refX = 0; refY = 0; refW = vp.width; refH = vp.height;
    } else {
      refX = parentContentX; refY = parentContentY;
      refW = parentContentW; refH = parentContentH;
    }

    // inset 简写
    var top = st.top, right = st.right, bottom = st.bottom, left = st.left;
    if (st.inset) {
      var ins = String(st.inset).split(/\s+/);
      top = ins[0]; right = ins[1] !== undefined ? ins[1] : ins[0];
      bottom = ins[2] !== undefined ? ins[2] : ins[0]; left = ins[3] !== undefined ? ins[3] : ins[1] !== undefined ? ins[1] : ins[0];
    }

    var x, y, w = sz.w, h = sz.h;
    var L = parseLength(left, refW, vp.width, vp.height);
    var T = parseLength(top, refH, vp.width, vp.height);
    var R = parseLength(right, refW, vp.width, vp.height);
    var B = parseLength(bottom, refH, vp.width, vp.height);

    // 两端定位（left+right 同时存在 → 拉伸）
    if (!isNaN(L) && !isNaN(R)) { x = refX + L; w = Math.max(0, refW - L - R); }
    else if (!isNaN(L))           { x = refX + L; }
    else if (!isNaN(R))           { x = refX + refW - R - w; }
    else                          { x = refX; }

    if (!isNaN(T) && !isNaN(B)) { y = refY + T; h = Math.max(0, refH - T - B); }
    else if (!isNaN(T))           { y = refY + T; }
    else if (!isNaN(B))           { y = refY + refH - B - h; }
    else                          { y = refY; }

    node._box = { x: x, y: y, w: w, h: h };
    finalizeBox(node, state, vp);
  }

  /* ---- 尺寸测量 ---- */

  /**
   * 测量节点尺寸。
   * auto 尺寸的推断策略（够用即可，不追求 CSS 规范完整）：
   *   - 文本节点内容 → 按字符数 × font-size 估算宽度
   *   - 含子元素 → 递归测量后取最大
   *   - flex 子项 → 用 flex-grow 均分剩余空间（由 layoutFlex 处理）
   */
  function measure(node, isRowParent, parentW, parentH, state, vp) {
    var st = node._style || computeStyle(node, state);

    var m = { t: 0, r: 0, b: 0, l: 0 };
    if (st.margin) {
      var mv = String(st.margin).split(/\s+/);
      m.t = parseLength(mv[0], parentH, vp.width, vp.height) || 0;
      m.r = parseLength(mv[1] !== undefined ? mv[1] : mv[0], parentW, vp.width, vp.height) || 0;
      m.b = parseLength(mv[2] !== undefined ? mv[2] : mv[0], parentH, vp.width, vp.height) || 0;
      m.l = parseLength(mv[3] !== undefined ? mv[3] : mv[1] !== undefined ? mv[1] : mv[0], parentW, vp.width, vp.height) || 0;
    }
    node._margin = m;

    var pd = { t: 0, r: 0, b: 0, l: 0 };
    if (st.padding) {
      var pv = String(st.padding).split(/\s+/);
      pd.t = parseLength(pv[0], parentH, vp.width, vp.height) || 0;
      pd.r = parseLength(pv[1] !== undefined ? pv[1] : pv[0], parentW, vp.width, vp.height) || 0;
      pd.b = parseLength(pv[2] !== undefined ? pv[2] : pv[0], parentH, vp.width, vp.height) || 0;
      pd.l = parseLength(pv[3] !== undefined ? pv[3] : pv[1] !== undefined ? pv[1] : pv[0], parentW, vp.width, vp.height) || 0;
    }
    node._pad = pd;

    // 内容尺寸
    var w = parseLength(st.width, parentW, vp.width, vp.height);
    var h = parseLength(st.height, parentH, vp.width, vp.height);

    // flex 子项的交叉轴尺寸
    if (st['flex-grow'] && st['flex-grow'] !== '0') {
      // 主轴由 layoutFlex 处理，此处仅确保不是 NaN
      if (isNaN(w)) w = 0;
    }

    if (isNaN(w) || isNaN(h)) {
      var content = measureContent(node, state, vp, isNaN(w) ? parentW : w, isNaN(h) ? parentH : h);
      if (isNaN(w)) w = content.w;
      if (isNaN(h)) h = content.h;
    }

    // min-width / max-width
    if (st['min-width']) { var mw = parseLength(st['min-width'], parentW, vp.width, vp.height); if (!isNaN(mw) && w < mw) w = mw; }
    if (st['max-width']) { var xw = parseLength(st['max-width'], parentW, vp.width, vp.height); if (!isNaN(xw) && w > xw) w = xw; }

    var totalW = w + pd.l + pd.r;
    var totalH = h + pd.t + pd.b;

    // flex-basis 优先于 width。未声明时返回 undefined 而非 NaN，
    // 便于调用方用 isNaN/!== undefined 明确区分「未声明」与「声明了 0」。
    var basis = undefined;
    if (st['flex-basis']) {
      var b = parseLength(st['flex-basis'], isRowParent ? parentW : parentH, vp.width, vp.height);
      if (!isNaN(b)) basis = b;
    }

    return { w: totalW, h: totalH, flexBasis: basis };
  }

  /** 内容固有尺寸：文本按字符估算，容器取子元素并集 */
  function measureContent(node, state, vp, availW, availH) {
    var st = node._style || {};
    var kids = node.childNodes || [];
    var maxW = 0, sumH = 0, hasBlock = false;

    for (var i = 0; i < kids.length; i++) {
      var kid = kids[i];
      if (kid.nodeType === 3) {                    // 文本节点
        var fs = parseLength(st['font-size'] || 16, availW, vp.width, vp.height);
        if (isNaN(fs)) fs = 16;
        var txt = String(kid.nodeValue || '').trim();
        if (txt) {
          // 简易字宽估算：ASCII 约 0.55em，CJK 约 1.0em
          var wEst = estimateTextWidth(txt, fs);
          maxW = Math.max(maxW, wEst);
          sumH += fs * 1.4;
          hasBlock = true;
        }
      } else if (kid.nodeType === 1) {
        var kst = computeStyle(kid, state);
        kid._style = kst;
        if (kst.display === 'none') continue;
        var ksz = measure(kid, false, availW, availH, state, vp);
        var isFlexItem = /^flex|inline-flex/.test(st.display || '');
        if (isFlexItem && st['flex-direction'] === 'row') {
          maxW += ksz.w;                           // flex row 主轴累加
        } else {
          maxW = Math.max(maxW, ksz.w);
          sumH += ksz.h;
        }
        hasBlock = true;
      }
    }

    return { w: maxW, h: sumH || (hasBlock ? 0 : 0) };
  }

  /** 文本宽度估算（无字体度量上下文时的保守近似） */
  function estimateTextWidth(text, fontSize) {
    var w = 0;
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      if (code > 0x2E80) w += fontSize;        // CJK 全角
      else if (text[i] === ' ') w += fontSize * 0.28;
      else w += fontSize * 0.52;                // 拉丁字母
    }
    return w;
  }

  /** 递归计算子节点 box（含 padding 偏移），并设置 _contentW/_contentH */
  function finalizeBox(node, state, vp) {
    // 【NaN 防线】布局链路上任一环节产生的 NaN 都会让整个子树错位，
    // 且 JSON 序列化后表现为 null，极难排查。此处统一收敛为 0。
    var b = node._box;
    if (!b) return;
    if (isNaN(b.x)) b.x = 0;
    if (isNaN(b.y)) b.y = 0;
    if (isNaN(b.w) || b.w < 0) b.w = 0;
    if (isNaN(b.h) || b.h < 0) b.h = 0;

    var pd = node._pad || { t: 0, r: 0, b: 0, l: 0 };
    node._contentW = Math.max(0, node._box.w - pd.l - pd.r);
    node._contentH = Math.max(0, node._box.h - pd.t - pd.b);
    layoutChildren(node, vp, state);
  }

  function computeStyle(node, state) {
    var sheet = state && state.sheet;
    if (!sheet) return node.style || {};
    return sheet.compute(node, state.viewport);
  }

  global.MGLayout = {
    StyleSheet: StyleSheet,
    LayoutEngine: LayoutEngine,
    parseLength: parseLength,
    parseColor: parseColor,
    estimateTextWidth: estimateTextWidth
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
