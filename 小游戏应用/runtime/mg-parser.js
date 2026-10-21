/*
 * mg-parser.js — HTML / CSS 解析器
 * ---------------------------------------------------------------
 * 运行时需要把游戏 HTML 的 <body> 片段与 <style> 内容解析为
 * 虚拟 DOM 树与样式表，供 mg-dom / mg-ui-layout 使用。
 *
 * 这不是通用 HTML 解析器，只覆盖本合集游戏实际使用的语法子集：
 *   - 标签、属性（id / class / style）、自闭合标签
 *   - 文本节点、HTML 注释
 *   - 内联 style 属性
 *   CSS：
 *   - 选择器 + 声明块
 *   - CSS 变量（--token）与 var() 引用
 *   - @media 查询：取第一个匹配目标分辨率的分支，其余丢弃
 *   - 伪元素 ::before/::after：布局层不参与，此处直接丢弃
 */
(function (global) {
  'use strict';

  var L = global.MGLayout;

  /* ============ HTML 解析 ============ */

  var VOID_TAGS = { br: 1, hr: 1, img: 1, input: 1, meta: 1, link: 1, source: 1, area: 1, base: 1, col: 1, embed: 1, param: 1, track: 1, wbr: 1 };
  var RAW_TAGS = { script: 1, style: 1, textarea: 1, title: 1 };

  /**
   * 解析 HTML 片段为虚拟 DOM。
   * @param {string} html
   * @returns {Element} 根节点（body）
   */
  function parseBody(html) {
    var root = new global.MGElement('body');
    var stack = [root];
    var str = String(html || '');
    var i = 0;

    function top() { return stack[stack.length - 1]; }

    while (i < str.length) {
      var lt = str.indexOf('<', i);
      if (lt < 0) {
        addText(stack, str.slice(i));
        break;
      }
      if (lt > i) addText(stack, str.slice(i, lt));

      // 注释
      if (str.substr(lt, 4) === '<!--') {
        var end = str.indexOf('-->', lt);
        i = end < 0 ? str.length : end + 3;
        continue;
      }
      // 闭合标签
      if (str.charAt(lt + 1) === '/') {
        var gt = str.indexOf('>', lt);
        if (gt < 0) break;
        var closeName = str.slice(lt + 2, gt).trim().toLowerCase();
        // 回退到匹配的开标签（HTML 允许省略闭合）
        for (var s = stack.length - 1; s > 0; s--) {
          if (top().tagName.toLowerCase() === closeName) { stack.length = s; break; }
        }
        i = gt + 1;
        continue;
      }
      // 开标签
      var gt2 = findTagEnd(str, lt);
      if (gt2 < 0) { addText(stack, str.slice(lt)); break; }
      var raw = str.slice(lt + 1, gt2);
      var selfClose = /\/\s*$/.test(raw);
      var nameMatch = raw.match(/^([a-zA-Z][\w-]*)/);
      if (!nameMatch) { i = gt2 + 1; continue; }

      var tag = nameMatch[1].toLowerCase();
      var attrs = parseAttrs(raw.slice(nameMatch[1].length));
      var el = makeElement(tag, attrs);

      top().appendChild(el);

      if (VOID_TAGS[tag]) { i = gt2 + 1; continue; }

      if (RAW_TAGS[tag]) {
        // 原样读取内容直到闭合标签（script/style 内容不应被当作 HTML 解析）
        var closeTag = '</' + tag;
        var ci = str.toLowerCase().indexOf(closeTag, gt2);
        var content = ci < 0 ? str.slice(gt2 + 1) : str.slice(gt2 + 1, ci);
        if (tag === 'style' || tag === 'script') {
          el._rawContent = content;
        }
        i = ci < 0 ? str.length : str.indexOf('>', ci) + 1;
        continue;
      }

      if (!selfClose) stack.push(el);
      i = gt2 + 1;
    }
    return root;
  }

  /** 查找标签的 `>`，跳过引号内的内容（属性值可能含 >） */
  function findTagEnd(str, start) {
    var q = null;
    for (var i = start + 1; i < str.length; i++) {
      var c = str.charAt(i);
      if (q) { if (c === q) q = null; }
      else if (c === '"' || c === "'") q = c;
      else if (c === '>') return i;
    }
    return -1;
  }

  function parseAttrs(s) {
    var out = {};
    var re = /([a-zA-Z_:][\w:.-]*)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;
    var m;
    while ((m = re.exec(s))) {
      var val = m[2] === undefined ? '' : m[2].replace(/^["']|["']$/g, '');
      out[m[1].toLowerCase()] = val;
    }
    return out;
  }

  function makeElement(tag, attrs) {
    var el = new global.MGElement(tag);
    if (attrs.id) el.id = attrs.id;
    if (attrs.class) el.className = attrs.class;
    if (attrs.style) {
      var st = parseStyleText(attrs.style);
      for (var k in st) el.style[k] = st[k];
    }
    return el;
  }

  function addText(stack, text) {
    if (!text) return;
    if (!/\S/.test(text)) {
      // 纯空白文本节点：无布局意义，跳过（避免大量空节点拖慢布局）
      return;
    }
    stack[stack.length - 1].appendChild(new global.MGTextNode(text));
  }

  /* ============ CSS 解析 ============ */

  /**
   * 解析样式文本为 StyleSheet。
   * @param {string} css
   * @param {object} [targetViewport] 视口尺寸；提供时按此值求值 @media
   */
  function parseCss(css, targetViewport) {
    var vp = targetViewport || global.MGPlatform.getScreen();
    var raw = stripComments(String(css || ''));
    var vars = extractCssVars(raw);

    var rules = [];
    var i = 0;

    while (i < raw.length) {
      // 跳过 @ 规则
      if (raw.charAt(i) === '@') {
        var atName = (raw.slice(i).match(/^@([a-zA-Z-]+)/) || [])[1];
        if (atName === 'media') {
          var consumed = handleMedia(raw, i, vp, vars, rules);
          i = consumed;
        } else {
          // @keyframes / @font-face / @supports 等：整块跳过
          i = skipAtRule(raw, i);
        }
        continue;
      }
      // 普通规则：selector { decls }
      var brace = raw.indexOf('{', i);
      if (brace < 0) break;
      var selector = raw.slice(i, brace).trim();
      var blockEnd = matchBrace(raw, brace);
      if (blockEnd < 0) break;
      var body = raw.slice(brace + 1, blockEnd);

      if (selector && !isPseudoElement(selector)) {
        var decls = parseDeclarations(body, vars);
        if (Object.keys(decls).length) {
          // 逗号分隔的选择器拆成多条规则
          var sels = splitSelectors(selector);
          for (var s = 0; s < sels.length; s++) {
            rules.push({ selector: sels[s], declarations: Object.assign({}, decls) });
          }
        }
      }
      i = blockEnd + 1;
    }
    return new L.StyleSheet(rules);
  }

  function stripComments(css) {
    return css.replace(/\/\*[\s\S]*?\*\//g, '');
  }

  /** 提取 :root / html / body 上的 CSS 变量，供 var() 引用 */
  function extractCssVars(css) {
    var vars = {};
    var re = /(--[\w-]+)\s*:\s*([^;}]+)[;}]/g;
    var m;
    while ((m = re.exec(css))) {
      // 只取 :root 作用域下的定义（本合集的 token 都在 :root）
      vars[m[1]] = m[2].trim();
    }
    return vars;
  }

  /** 处理 @media：条件匹配则纳入规则，否则跳过 */
  function handleMedia(css, start, vp, vars, rules) {
    var open = css.indexOf('{', start);
    if (open < 0) return css.length;
    var end = matchBrace(css, open);
    if (end < 0) return css.length;
    var cond = css.slice(start, open);
    var body = css.slice(open + 1, end);

    if (mediaMatches(cond, vp)) {
      // 把匹配分支的规则展开进主规则表
      var inner = parseCss(body, vp);
      for (var i = 0; i < inner.rules.length; i++) rules.push(inner.rules[i]);
    }
    return end + 1;
  }

  /** @media 条件求值：支持 min-aspect-ratio / max-width / orientation */
  function mediaMatches(cond, vp) {
    var c = cond.replace(/^@media\s*/i, '').trim();
    var ar = c.match(/\(\s*(min|max)-aspect-ratio\s*:\s*([\d./]+)\s*\)/i);
    if (ar) {
      var want = evalRatio(ar[2]);
      var actual = vp.width / vp.height;
      if (isNaN(want)) return false;
      return ar[1].toLowerCase() === 'min' ? actual >= want : actual <= want;
    }
    var w = c.match(/\(\s*(min|max)-width\s*:\s*(\d+)px\s*\)/i);
    if (w) {
      return w[1].toLowerCase() === 'min' ? vp.width >= +w[2] : vp.width <= +w[2];
    }
    var h = c.match(/\(\s*(min|max)-height\s*:\s*(\d+)px\s*\)/i);
    if (h) {
      return h[1].toLowerCase() === 'min' ? vp.height >= +h[2] : vp.height <= +h[2];
    }
    return false;   // 无法判定 → 不纳入（保守，避免错误样式干扰布局）
  }

  function evalRatio(expr) {
    var p = String(expr).split('/');
    if (p.length === 2) return parseFloat(p[0]) / parseFloat(p[1]);
    return parseFloat(expr);
  }

  function skipAtRule(css, start) {
    var open = css.indexOf('{', start);
    if (open < 0) return css.length;
    var end = matchBrace(css, open);
    return end < 0 ? css.length : end + 1;
  }

  /** 找到与 { 匹配的 } 位置，正确跳过嵌套与字符串 */
  function matchBrace(css, openIdx) {
    var depth = 0, q = null;
    for (var i = openIdx; i < css.length; i++) {
      var c = css.charAt(i);
      if (q) { if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return i; }
    }
    return -1;
  }

  function isPseudoElement(sel) {
    return /::/.test(sel);
  }

  /** 拆分逗号选择器，但不做括号内拆分（本合集无 :is()/:not() 复杂用法） */
  function splitSelectors(sel) {
    return sel.split(',').map(function (s) { return s.trim(); })
               .filter(function (s) { return s && !isPseudoElement(s); });
  }

  /** 解析声明块，返回 {prop: value}，并解引用 var() */
  function parseDeclarations(body, vars) {
    var out = {};
    var parts = body.split(';');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      var colon = p.indexOf(':');
      if (colon < 0) continue;
      var prop = p.slice(0, colon).trim().toLowerCase();
      var val = p.slice(colon + 1).trim();
      if (!prop || !val) continue;
      val = resolveVars(val, vars, 0);
      if (val) out[prop] = val;
    }
    return out;
  }

  /** var(--x) 递归解引用，限制深度防循环引用 */
  function resolveVars(val, vars, depth) {
    if (depth > 5 || val.indexOf('var(') < 0) return val;
    return val.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/g, function (_, name, fallback) {
      var v = vars[name];
      if (v === undefined) return fallback || '';
      return resolveVars(v, vars, depth + 1);
    }).trim();
  }

  /** 解析内联 style 属性文本（函数声明，会被提升，供 makeElement 安全引用） */
  function parseStyleText(text) {
    return parseDeclarations(String(text || ''), {});
  }

  global.MGParser = {
    parseBody: parseBody,
    parseCss: parseCss,
    parseStyleText: parseStyleText,
    parseDeclarations: parseDeclarations
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
