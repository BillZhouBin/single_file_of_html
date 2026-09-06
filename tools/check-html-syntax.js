#!/usr/bin/env node
/**
 * 单文件 HTML 合集 · 提交前语法护栏
 *
 * 遍历工作区内所有 *.html，提取内联 <script> 内容，用 new Function() 做
 * 纯语法校验（只编译、不执行 DOM，因此安全，不会因未声明变量而误报）。
 * 任一文件语法错误则 exit(1)，用于 pre-commit 拦截。
 *
 * 用法: node tools/check-html-syntax.js [rootDir]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = process.argv[2] || process.cwd();
const SKIP = new Set(['.git', 'node_modules', '.workbuddy', 'tools']);

// 递归收集所有 .html
function walk(dir, out) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { return; }
  for (const e of ents) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.html') || e.name.endsWith('.js')) out.push(p);
  }
}

const files = [];
walk(root, files);

let errCount = 0;
let checked = 0;

const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;

for (const f of files) {
  let src;
  try { src = fs.readFileSync(f, 'utf8'); }
  catch (e) { console.log('SKIP(read fail) ' + f + ': ' + e.message); continue; }

  // .js 文件（含 shared.js）：整体语法校验
  if (f.endsWith('.js')) {
    if (!src.trim()) continue;
    checked++;
    // 去掉 shebang 后再校验，避免 new Function 报 SyntaxError
    const stripped = src.replace(/^#!.*\n/, '');
    try { new Function(stripped); }
    catch (e) { errCount++; console.log('SYNTAX ERROR  ' + f + '  ' + e.message); }
    continue;
  }

  let m, idx = 0;
  while ((m = re.exec(src))) {
    idx++;
    const attrs = m[1] || '';
    const code = m[2] || '';
    if (/\bsrc\s*=/.test(attrs)) continue;            // 外链脚本：无内联内容
    if (/type\s*=\s*["']?module/i.test(attrs)) {       // ES module：含 import/export，new Function 不支持，跳过
      console.log('SKIP(module) ' + f + ' [script#' + idx + ']');
      continue;
    }
    if (!code.trim()) continue;
    checked++;
    try {
      new Function(code);
    } catch (e) {
      errCount++;
      const rel = path.relative(root, f) || f;
      console.log('SYNTAX ERROR  ' + rel + '  [script#' + idx + ']  ' + e.message);
    }
  }
}

if (errCount > 0) {
  console.log('\n[FAIL] ' + errCount + ' HTML file(s) have script syntax errors.');
  process.exit(1);
}
console.log('[PASS] ' + checked + ' inline <script> block(s) across ' + files.length + ' HTML file(s) checked, no syntax errors.');
