# 架构说明

## 一、核心问题

小游戏运行时是「阉割版浏览器」：有 Canvas 绘图与触摸事件，但
**没有 DOM、没有 CSS、没有 Web Audio**（支付宝更是连 Web Audio 都没有）。

而本合集的游戏是纯 Web 技术栈写的：

| 能力 | 用量（实测基线：迁移前 8 款） |
|------|----------------------|
| `classList` 操作 | 108 处 |
| `textContent` 读写 | 69 处 |
| `.remove()` | 58 处 |
| `style` 写入 | 38 处 |
| `getElementById` | 6~35 处 / 游戏 |
| CSS class 选择器规则 | 274 条 |
| Web Audio 合成 | 6 款游戏使用 |
| `<canvas>` | 每款 1 个 |

结论：**游戏逻辑可以复用，UI 呈现层必须重建**。

---

## 二、三层架构

```
┌─────────────────────────────────────────────────┐
│  游戏源码（原样注入，零改动）                     │
│  document.getElementById / classList /          │
│  textContent / AudioContext / localStorage      │
└──────────────────┬──────────────────────────────┘
                   │ 只依赖标准 Web API 名称
┌──────────────────▼──────────────────────────────┐
│  runtime/ 适配层（10 个模块，顺序不可调换）       │
│                                                  │
│  mg-platform   平台探测 + 能力探测               │
│  mg-storage    localStorage → wx/my/tt/jd       │
│  mg-canvas     Canvas 创建 / HiDPI / 原型补丁     │
│  mg-audio      WebAudio + 静音降级               │
│  mg-input      触摸 → pointer/mouse/touch 扇出   │
│  mg-parser     HTML/CSS 解析                    │
│  mg-ui-layout  flex + absolute 布局引擎          │
│  mg-ui-render  Canvas 渲染器                    │
│  mg-dom        虚拟 DOM + document 兼容         │
│  mg-lifecycle  主循环 + 前后台                   │
└──────────────────┬──────────────────────────────┘
                   │ 只认 MG* 全局符号
┌──────────────────▼──────────────────────────────┐
│  宿主：wx / tt / my / jd                         │
└─────────────────────────────────────────────────┘
```

**装配顺序是硬依赖**：`mg-platform` 必须最先（其余模块都要读它的能力探测结果），
`mg-lifecycle` 必须最后（它要拿到前 9 个都就绪）。

---

## 三、六个关键设计决策

### 1. 能力探测优先于文档假设

四平台能力差异大且文档不全（京东尤其）。因此**禁止** `if (platform === 'alipay')` 这种写法，
所有分支必须走 `MGPlatform.caps`：

```js
// ✅ 正确
if (MGPlatform.caps.webAudio) { ... }

// ❌ 错误：文档未明确的能力一旦变化就崩
if (MGPlatform.id !== 'alipay') { new AudioContext() }
```

`caps` 的每个字段都来自 `mg-platform.js` 里的实际探测（`typeof fn === 'function'` +
实例能力校验），不是查表得来的。

### 2. WebAudio 探测要校验实例，不只看函数存在

支付宝的 `my` 命名空间下没有 `createWebAudioContext`，但探测逻辑不能只判断
`typeof api.createWebAudioContext === 'function'`——某些容器可能提供函数却返回
不含 `createOscillator` 的残缺对象。因此探测会**实际调用并校验节点工厂**：

```js
if (ctx && typeof ctx.createOscillator === 'function' &&
    typeof ctx.createGain === 'function' && ctx.destination !== undefined) {
  return { ok: true, ctx };
}
```

无 WebAudio 时注入一套 **noop 实现**而非 `undefined`，
保证游戏里 `new AudioContext()` 与后续节点调用都不抛错——静音比崩溃好。

### 3. 上屏 canvas 只有一个，必须锁定给主画布

微信/抖音/支付宝的 `createCanvas()` 都是「**首次调用返回上屏 canvas，
第二次起返回离屏 canvas**」。这意味着如果离屏预渲染（精灵烘焙）先于主画布创建，
游戏就会拿到一块离屏画布——**画面全黑，且不报错**。

`mg-canvas.js` 用 `mainCanvas` 标记锁定首调归属，
`mg-dom.js` 在绑定虚拟 `<canvas>` 元素时主动调用 `MGCanvas.create(false)` 抢占首调。

### 4. DOM 覆盖层用「够用即可」的布局引擎还原

游戏 UI 用 DOM + CSS 构建，直接手写成 Canvas 绘制不现实（8 款游戏 × 多套 UI）。
因此实现了 CSS 子集布局引擎，覆盖实测的全部实际用法：

- 盒模型、margin / padding / border
- 定位：static / relative / absolute / fixed（含 `inset` 简写、两端拉伸）
- Flex：direction / justify-content（含 space-between/around/evenly）/ align-items / gap
- 单位：px / % / vw / vh / rem
- 文本：font-size / weight / color / align / line-height / nowrap
- 视觉：background（含 `linear-gradient`）/ border-radius / opacity / z-index
- CSS 变量 `var(--token)` 解引用
- `@media` 按目标分辨率求值

**关键机制**：`display:none` 通过 `classList.add/remove('hidden')` 切换，
这是游戏里控制菜单显隐的核心手段（58 处 `.remove()`）。布局阶段跳过 `display:none`
子树，渲染阶段同样跳过——两端一致才能正确隐藏。

### 5. 触摸事件要扇出成三套

游戏混用 `pointerdown` / `mousedown` / `touchstart`（实测 20+ 处绑定）。
小游戏只给 `onTouchStart/Move/End/Cancel`，参数结构也不同。因此适配层把一次触摸
**同时派发为 pointer + mouse + touch 三套事件**，让任何一套绑定都能响应。

坐标统一为 CSS 逻辑像素（小游戏坐标系即 CSS px），与 Canvas 绘制坐标一致。

### 6. 解析逻辑单一来源

构建期（`src/build.js`）抽取 HTML 的 CSS/JS/body，与运行期（`mg-parser.js`）解析
**语义必须一致**，否则「构建以为剥掉了 script，运行期却没剥」这类问题极难排查。
两边都遵守同一套规则：`<script>` / `<style>` / `<link>` / 注释不出现在 body 骨架里。

---

## 四、构建期对游戏源码的两处手术

原则是**能不改就不改**。只有两处必须改，每次改写都记录进产物的 `build-report.json`：

| 手术 | 原因 |
|------|------|
| 移除 `CanvasRenderingContext2D.roundRect` 兼容补丁 | 原补丁依赖该构造器，小游戏里挂载位置不同；运行时由 `mg-canvas.patchContext()` 统一提供 |
| 移除 `@import url(https://fonts...)` | 小游戏禁止外链资源，字体回退系统字体 |

另有一步**内联**（不改逻辑，只改加载方式）：`shared.js` 通过 `<script src>` 引入，
小游戏不支持，改为构建期内联并做挂载目标归一
（`shared.js` 挂到 `window`，游戏用裸标识符 `SharedGame` 访问全局，需同步为同一实例）。

---

## 五、验证策略

三层验证，逐层收紧：

| 层 | 工具 | 能发现什么 | 不能发现什么 |
|----|------|-----------|-------------|
| 1. 离线结构验证 | `src/verify.js`（Node vm 沙盒 + 宿主桩） | 语法错误、API 缺失、布局 NaN、能力探测错误、事件扇出 | 视觉还原度 |
| 2. 浏览器渲染 | `src/preview.js` + Chrome 无头截图 | 真实 Canvas 绘制、UI 还原、无运行时异常 | 真机差异（rAF、字体、性能） |
| 3. 真机 | 平台开发者工具 | 全部 | — |

第 1 层是主力。它在开发过程中实际抓出了 6 个真实阻塞点：
`Image` 未定义、`createElement('canvas')` 未代理、`parentElement` 缺失、
`style.setProperty` 缺失、`SharedGame` 挂载目标错位、flex 布局 NaN 污染。

---

## 六、踩过的坑（供后续维护参考）

### 只读全局槽位

浏览器里 `window` / `document` / `localStorage` 都是 Window 上的
**[Replaceable] 只访问器属性**，直接赋值抛
`TypeError: Cannot set property localStorage of which has only a getter`。
适配层统一用 `safeAssign` 包装；浏览器预览时改为**桥接原生 document** 到虚拟 DOM
（`preview.js` 里的延迟桥接：先走原生，虚拟 DOM 就绪后自动切换）。

### 布局 NaN 会静默污染整棵树

`flex-basis` 未声明时若返回 `NaN`（而非 `undefined`），会经
`contents[i] → basis → _box` 传播，最终 JSON 序列化成 `null`，排查极难。
现在有三道防线：`measure` 返回 `undefined`、`layoutFlex` 显式 `isNaN` 回退、
`finalizeBox` 统一收敛为 0。

### 内联进 HTML 时 `</script>` 会提前闭合脚本块

`preview.js` 把 `game.js` 内联进 `<script>` 时，产物里的字面量 `</script>`
会让浏览器提前闭合脚本块，后半段被当 HTML 解析 → `SyntaxError`。
需转义为 `<\/script`。**注意这只是预览壳的问题**，小游戏里 game.js 是独立文件。

### 按钮类 canvas 的 `getContext` 代理

有些游戏把 `div` 容器当画布用（`document.getElementById('game').getContext('2d')`，
grass-survivor 即是）。因此 `getElementById` 的兜底逻辑是：
**任何元素**若没有 `getContext`，都按需绑定宿主画布代理。

---

## 七、后续可做方向

1. **UI 精度提升**——当前布局引擎对多层 flex 嵌套有偏移。
   可引入字宽度量缓存、或针对高频 UI 模式做专门优化。
2. **支付宝音效方案**——构建期用 Node 离线渲染 Web Audio 音色为 wav/mp3，
   运行时用 `createInnerAudioContext` 播放，代价是包体增长。
3. **`box-shadow` / `backdrop-filter`**——用多层半透明矩形近似毛玻璃与阴影。
4. **分包加载**——当前主包 130~190KB，远未触及 4MB 限制，暂不需要。
5. **`@keyframes` 支持**——为 `.hidden` 之外的过渡动画（如 overlay 淡入淡出）提供补间。
