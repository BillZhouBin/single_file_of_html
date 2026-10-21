/*
 * mg-ui-render.js — DOM 覆盖层的 Canvas 渲染器
 * ---------------------------------------------------------------
 * 消费 mg-ui-layout 算好的盒树，在 Canvas 上还原视觉：
 *   背景（含 linear-gradient）→ 边框 → 圆角矩形 → 文本
 *
 * 关键约束：
 *   1. 只绘制元素节点与文本节点，跳过注释。
 *   2. display:none 的节点（及其子树）不绘制——这是游戏里
 *      classList.add/remove('hidden') 控制菜单显示的核心机制（58 处 .remove 调用）。
 *   3. z-index 决定绘制顺序，DOM 顺序作为次级排序依据。
 *   4. 文本不换行（white-space:nowrap）或按容器宽度换行，
 *      与浏览器默认行为对齐。
 */
(function (global) {
  'use strict';

  var L = global.MGLayout;
  var parseColor = L.parseColor;

  /* ============ 渐变解析 ============ */

  /**
   * 解析 linear-gradient(...) 为 Canvas 渐变对象。
   * 支持方向关键字（to right / to bottom / 180deg）与双颜色停靠点。
   * 不支持时返回 null，调用方回退为首个颜色纯色填充。
   */
  function makeLinearGradient(ctx, cssValue, x0, y0, x1, y1) {
    if (!cssValue || cssValue.indexOf('gradient') < 0) return null;
    var g = ctx.createLinearGradient(x0, y0, x1, y1);
    var m = String(cssValue).match(/linear-gradient\(([^)]+)\)/);
    if (!m) return null;
    var parts = m[1].split(',').map(function (s) { return s.trim(); });

    // 首个可能是方向
    var dir = parts[0];
    var stops = parts;
    if (/^(to\s|deg|rad|turn)/.test(dir)) {
      stops = parts.slice(1);
      var ang = 0;
      if (/^to\s+right/.test(dir)) ang = 0;
      else if (/^to\s+left/.test(dir)) ang = 180;
      else if (/^to\s+bottom/.test(dir)) ang = 90;
      else if (/^to\s+top/.test(dir)) ang = 270;
      else {
        var dm = dir.match(/(-?\d+(?:\.\d+)?)deg/);
        if (dm) ang = parseFloat(dm[1]);
      }
      var rad = (ang - 90) * Math.PI / 180;
      g = ctx.createLinearGradient(
        x0 + Math.cos(rad) * (x1 - x0) / 2, y0 + Math.sin(rad) * (y1 - y0) / 2,
        x0 - Math.cos(rad) * (x1 - x0) / 2, y0 - Math.sin(rad) * (y1 - y0) / 2
      );
    }

    for (var i = 0; i < stops.length; i++) {
      var sp = stops[i].match(/^(#[0-9a-f]{3,8}|rgba?\([^)]+\)|\w+)\s*(.*)$/i);
      if (!sp) continue;
      var col = parseColor(sp[1]);
      if (!col) continue;
      var off = sp[2] ? parseFloat(sp[2]) : null;
      g.addColorStop(off === null || isNaN(off) ? (stops.length === 1 ? 0 : i / (stops.length - 1)) : off,
                     'rgba(' + col.r + ',' + col.g + ',' + col.b + ',' + col.a + ')');
    }
    return g;
  }

  /* ============ 文本渲染 ============ */

  function fontString(st, vp) {
    var size = parseFloat(st['font-size'] || 16);
    if (isNaN(size)) size = 16;
    // 小游戏无自定义字体（外链字体被禁），统一用系统字体族
    var weight = st['font-weight'] || '400';
    return (weight === 'bold' || parseInt(weight, 10) >= 600 ? 'bold ' : '') +
           size + 'px ' + (st['font-family'] || 'sans-serif');
  }

  /** 按容器宽度做贪心换行，返回行数组 */
  function wrapText(ctx, text, maxWidth) {
    if (!maxWidth || maxWidth <= 0) return [text];
    var lines = [], line = '';
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (ch === '\n') { lines.push(line); line = ''; continue; }
      var test = line + ch;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = ch;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  /* ============ 渲染器 ============ */

  function Renderer() {
    this.debug = false;
  }

  /**
   * 渲染 DOM 树。
   * @param {CanvasRenderingContext2D} ctx 目标上下文
   * @param {object} root 布局根节点
   */
  Renderer.prototype.render = function (ctx, root) {
    if (!ctx || !root) return;
    // 收集全部可见节点，按 z-index + DOM 顺序排序后绘制
    var nodes = [];
    collect(root, nodes);
    nodes.sort(function (a, b) {
      var za = a._style ? (parseInt(a._style['z-index'], 10) || 0) : 0;
      var zb = b._style ? (parseInt(b._style['z-index'], 10) || 0) : 0;
      if (za !== zb) return za - zb;
      return a._order - b._order;      // DOM 顺序（文档流）作为次级键
    });
    for (var i = 0; i < nodes.length; i++) {
      try { this.paintNode(ctx, nodes[i]); }
      catch (e) { /* 单节点绘制失败不影响其余 */ }
    }
    if (this.debug) this.paintDebug(ctx, nodes);
  };

  /** 深度优先收集，_order 保证排序稳定 */
  function collect(node, out) {
    if (!node || node.nodeType !== 1) return;
    if (node._style && node._style.display === 'none') return;   // hidden 子树整棵跳过
    if (node._box) {
      node._order = out.length;
      out.push(node);
    }
    var kids = node.childNodes || [];
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].nodeType === 1) collect(kids[i], out);
    }
  }

  /** 绘制单个元素（背景 + 边框 + 其文本） */
  Renderer.prototype.paintNode = function (ctx, node) {
    var st = node._style || {};
    var box = node._box;
    if (!box) return;

    // 全局不透明度
    var op = st.opacity !== undefined ? parseFloat(st.opacity) : 1;
    if (isNaN(op) || op <= 0) return;

    var savedOp = ctx.globalAlpha;
    if (op < 1) ctx.globalAlpha = savedOp * op;

    this.paintBackground(ctx, node, st, box);
    this.paintBorder(ctx, st, box);
    this.paintOwnText(ctx, node, st, box);

    ctx.globalAlpha = savedOp;
  };

  /** 背景：纯色 / 渐变 / 背景图（背景图在小游戏不可用，安全忽略） */
  Renderer.prototype.paintBackground = function (ctx, node, st, box) {
    var bg = st.background;
    if (!bg || bg === 'none' || bg === 'transparent') return;
    if (bg.indexOf('url(') >= 0) return;        // 小游戏禁外链资源

    var radius = parseRadius(st['border-radius'], box.w, box.h);
    var fill = null;

    if (bg.indexOf('gradient') >= 0) {
      // 渐变默认方向 to bottom
      fill = makeLinearGradient(ctx, bg, box.x, box.y, box.x, box.y + box.h);
      if (!fill) {
        var first = bg.match(/(#[0-9a-f]{3,8}|rgba?\([^)]+\))/i);
        fill = first ? parseColor(first[1]) : null;
      }
    } else {
      fill = parseColor(bg);
    }
    if (!fill) return;

    if (radius) {
      ctx.beginPath();
      roundRectPath(ctx, box.x, box.y, box.w, box.h, radius);
      ctx.fillStyle = typeof fill === 'string' ? fill
        : 'rgba(' + fill.r + ',' + fill.g + ',' + fill.b + ',' + fill.a + ')';
      ctx.fill();
    } else {
      ctx.fillStyle = typeof fill === 'string' ? fill
        : 'rgba(' + fill.r + ',' + fill.g + ',' + fill.b + ',' + fill.a + ')';
      ctx.fillRect(box.x, box.y, box.w, box.h);
    }
  };

  /** 边框：仅支持统一宽度与颜色的简写 */
  Renderer.prototype.paintBorder = function (ctx, st, box) {
    var bd = st.border;
    if (!bd) return;
    var m = String(bd).match(/(-?\d+(?:\.\d+)?)px\s+(#[0-9a-f]{3,8}|rgba?\([^)]+\)|\w+)/i);
    if (!m) return;
    var w = parseFloat(m[1]);
    var col = parseColor(m[2]);
    if (!col || w <= 0) return;

    var radius = parseRadius(st['border-radius'], box.w, box.h);
    ctx.beginPath();
    if (radius) roundRectPath(ctx, box.x, box.y, box.w, box.h, radius);
    else ctx.rect(box.x, box.y, box.w, box.h);
    ctx.strokeStyle = 'rgba(' + col.r + ',' + col.g + ',' + col.b + ',' + col.a + ')';
    ctx.lineWidth = w;
    ctx.stroke();
  };

  /** 绘制元素的直接文本子节点 */
  Renderer.prototype.paintOwnText = function (ctx, node, st, box) {
    var kids = node.childNodes || [];
    var texts = [];
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].nodeType === 3) {
        var t = String(kids[i].nodeValue || '').trim();
        if (t) texts.push(t);
      }
    }
    if (!texts.length) return;

    var color = parseColor(st.color || '#000');
    ctx.fillStyle = color
      ? 'rgba(' + color.r + ',' + color.g + ',' + color.b + ',' + color.a + ')'
      : '#000';
    ctx.font = fontString(st, null);
    ctx.textBaseline = 'middle';

    var lineH = parseFloat(st['line-height']) || parseFloat(st['font-size']) * 1.4 || 20;
    var nowrap = st['white-space'] === 'nowrap';
    var lines = nowrap ? [texts.join(' ')] : wrapText(ctx, texts.join(' '), box.w);

    var y = box.y + (box.h - lines.length * lineH) / 2 + lineH / 2;
    for (var k = 0; k < lines.length; k++) {
      var ln = lines[k];
      var tw = ctx.measureText(ln).width;
      var x = box.x;
      if (st['text-align'] === 'center') x = box.x + (box.w - tw) / 2;
      else if (st['text-align'] === 'right' || st['text-align'] === 'end') x = box.x + box.w - tw;

      // 文字阴影（text-shadow）
      if (st['text-shadow']) {
        var sm = String(st['text-shadow']).match(/(-?\d+(?:\.\d+)?)px\s+(-?\d+(?:\.\d+)?)px\s+(#[0-9a-f]{3,8}|rgba?\([^)]+\))/i);
        if (sm) {
          var sc = parseColor(sm[3]);
          if (sc) {
            ctx.fillStyle = 'rgba(' + sc.r + ',' + sc.g + ',' + sc.b + ',' + sc.a * 0.7 + ')';
            ctx.fillText(ln, x + parseFloat(sm[1]), y + parseFloat(sm[2]));
            ctx.fillStyle = color ? 'rgba(' + color.r + ',' + color.g + ',' + color.b + ',' + color.a + ')' : '#000';
          }
        }
      }
      ctx.fillText(ln, x, y);
      y += lineH;
    }
  };

  /** 调试模式：绘制盒模型边框与 id/class 标签 */
  Renderer.prototype.paintDebug = function (ctx, nodes) {
    ctx.save();
    ctx.lineWidth = 1;
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i], b = n._box;
      if (!b) continue;
      ctx.strokeStyle = 'rgba(255,0,128,0.6)';
      ctx.strokeRect(b.x, b.y, b.w, b.h);
      if (b.w > 30 && b.h > 14) {
        ctx.fillStyle = 'rgba(255,0,128,0.9)';
        ctx.font = '9px monospace';
        ctx.textBaseline = 'top';
        ctx.fillText(n.id || (n.className || '').split(' ')[0] || n.tagName, b.x + 1, b.y + 1);
      }
    }
    ctx.restore();
  };

  /* ---- 圆角辅助 ---- */

  function parseRadius(v, w, h) {
    if (!v) return 0;
    var s = String(v).trim();
    var num = parseFloat(s);
    if (isNaN(num)) return 0;
    if (s.indexOf('%') >= 0) {
      num = (w < h ? w : h) * num / 100;
    }
    // 胶囊形：单值等于 9999px（游戏里用于药丸按钮）
    return Math.min(num, Math.min(w, h) / 2);
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    if (typeof ctx.roundRect === 'function') { ctx.roundRect(x, y, w, h, r); return; }
    var rr = typeof r === 'number' ? [r, r, r, r] : r;
    while (rr.length < 4) rr.push(rr[0]);
    ctx.moveTo(x + rr[0], y);
    ctx.lineTo(x + w - rr[1], y);
    ctx.arcTo(x + w, y, x + w, y + rr[1], rr[1]);
    ctx.lineTo(x + w, y + h - rr[2]);
    ctx.arcTo(x + w, y + h, x + w - rr[2], y + h, rr[2]);
    ctx.lineTo(x + rr[3], y + h);
    ctx.arcTo(x, y + h, x, y + h - rr[3], rr[3]);
    ctx.lineTo(x, y + rr[0]);
    ctx.arcTo(x, y, x + rr[0], y, rr[0]);
    ctx.closePath();
  }

  global.MGUIRender = { Renderer: Renderer };
})(typeof globalThis !== 'undefined' ? globalThis : this);
