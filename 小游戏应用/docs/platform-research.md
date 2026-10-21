# 四平台能力勘查结论

> 勘查日期：2026-10-03。本文是 `config/platforms.json` 与 `runtime/` 全部降级决策的事实依据。
> 原则：**能力靠运行时探测，不靠文档假设**。文档未明确的能力一律标记 `unknown` + `probe`。

## 一、结论速查

| 能力 | 微信 | 抖音 | 支付宝 | 京东 |
|------|------|------|--------|------|
| JS 命名空间 | `wx` | `tt` | `my` | `jd` |
| WebAudio 合成 | ✅ `createWebAudioContext` (2.19.0+) | ✅ `getAudioContext` (1.34.0+) | ❌ **无** | ❓ 未知 → 探测 |
| 上屏 canvas | ✅ `createCanvas()` | ✅ `createCanvas()` | ⚠️ `createCanvasContext`（旧式） | ❓ 未知 → 探测 |
| 同步存储 | ✅ | ✅ | ✅ | ✅ |
| 震动 | ✅ | ✅ | ✅ | ✅ |
| 横竖屏切换 | ✅ 2.4.0+ | ✅ | ❌ | ❓ 探测 |

## 二、WebAudio：唯一真正的架构分歧点

本合集所有游戏的音效均为 **Web Audio 程序化合成**（`OscillatorNode` + `GainNode` + `BiquadFilterNode`），
零外部音频资源——这在 Web 上是优点，在小游戏中是风险。

- **微信**：`wx.createWebAudioContext()`，基础库 **2.19.0** 起支持。官方文档明确列出已支持节点：
  `OscillatorNode` / `GainNode` / `BiquadFilterNode` / `BufferSourceNode` / `DelayNode` /
  `DynamicsCompressorNode` / `IIRFilterNode` / `WaveShaperNode` / `PeriodicWaveNode` /
  `PannerNode` / `ScriptProcessorNode` / `ChannelSplitterNode` / `ChannelMergerNode` / `ConstantSourceNode`。
  → 本合集用到的三种节点**全部覆盖**。
  风险：低版本基础库（<2.19.0）调用会失败，必须 try/catch 降级为静音。

- **抖音**：`tt.getAudioContext()`（同步方法，基础库 1.34.0+）。官方明示「按照 W3C Web Audio API 设计实现」，
  并额外提供 `DelayNode` / `EqualizerNode` / `F0DetectionNode` 等。采样率仅支持
  44.1k / 22.05k / 11.025k / 8k / 16k / 24k / 32k / 48k kHz。
  → 兼容性最好。注意采样率受限，若未来引入采样音频需按 44.1kHz 导出。

- **支付宝**：官方小游戏 API 总览「音频」分类下**只有** `my.createInnerAudioContext`（播放 mp3 等音频文件），
  **没有** `createWebAudioContext`，也没有任何 `createOscillator` 类接口。
  官方另提供 `adaptor.js` 供 Cocos / Laya 抹平差异，但那是给引擎用的，不提供 WebAudio 合成。
  → **程序化合成音效在支付宝端不可用**，只能：
    1. 降级为静音（默认，零成本）；或
    2. 构建期把音色离线渲染为 wav/mp3，运行时用 `InnerAudioContext` 播放（体积换体验）。
  本框架默认走 (1)，并预留 (2) 的 `AudioAssetRegistry` 钩子。

- **京东**：容器与微信小游戏同源，API 命名对齐 `jd.*`，但公开文档未明确 WebAudio 支持情况。
  → 运行时探测：尝试 `jd.createWebAudioContext()`，成功则用，抛错则静音。

## 三、Canvas

- 微信/抖音：`createCanvas()` **首次调用返回上屏 canvas，第二次起返回离屏 canvas**。
  → 适配层必须把「首次调用」的结果留给游戏主画布，之后的调用才用于离屏预渲染（精灵烘焙）。
- 支付宝：官方文档明示 `my.createCanvasContext` 同样是「第一次创建上屏 canvas，第二次创建离屏 canvas」，
  但该接口是**旧式命令队列 API**（`ctx.draw()` 提交），不是 `getContext('2d')` 的实时上下文。
  这意味着本合集里大量 `ctx.arc()` / `ctx.fillRect()` 之后需要 `draw()` 提交的代码在支付宝端语义不同。
  → 适配层需探测 `canvas.getContext` 是否可用；不可用时对旧式 API 做 draw() 自动补齐。

## 四、存储

四平台均有同步/异步 Storage API（`setStorageSync` / `getStorageSync` / `removeStorageSync`），
接口形态与 `localStorage` 接近但不完全一致（`localStorage.removeItem` → `removeStorageSync`）。
→ `runtime/storage.js` 做双向映射，接口签名对齐 `localStorage`，游戏代码零改动。

## 五、输入

- 四平台均提供 `onTouchStart/Move/End/Cancel`，回调参数为 `{ touches: [{clientX, clientY, identifier}] }`。
- 本合集游戏使用 `pointerdown/move/up`、`touchstart`、`mousedown`、`keydown` 混合事件。
  → 适配层把 touch 事件**同时派发**为 pointer + mouse + touch 三套事件，并对 `preventDefault` 做空实现。
- 键盘：四平台均无物理键盘事件绑定（部分平台无任何键盘 API）。
  → 键盘路径降级为「调试用」，所有游戏已实现触摸输入，键盘不是必需路径。

## 六、其他约束

- **禁止外链资源**：本合集游戏字体走 Google Fonts CDN，转换时必须回退到系统字体或 Canvas 绘制。
- **包体限制**：主包 4MB（京东主包 4MB / 分包 16MB）。本合集游戏全部为「零外部资源、程序化绘制」，
  单个 JS 通常 < 200KB，包体无压力。
- **横竖屏**：支付宝不支持 `setDeviceOrientation`，横屏游戏（如一骑当千）在支付宝端需按竖屏或固定横屏处理。
- **平台准入**：京东小游戏处于邀请制，需申请接入资格。

## 七、对转换器的要求

1. **不硬编码平台判断**——所有分支走 `runtime/platform.js` 的能力探测。
2. **降级必须静默**——WebAudio 不可用时静音而非抛错；这类环境差异在真机上才会暴露。
3. **DOM UI 全部 canvas 化**——这是工作量最大的一块，见 `docs/architecture.md`。
