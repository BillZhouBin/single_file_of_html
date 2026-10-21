# 小游戏应用 · 单文件 HTML → 四平台小游戏

把 `single_file_of_html` 合集里的单文件 HTML 游戏，转换成可分发到
**微信 / 抖音 / 支付宝 / 京东** 四家小游戏平台的工程包。

核心设计：**游戏源码零改动**。所有平台差异由 `runtime/` 适配层吸收。

---

## 一、快速开始

```bash
cd 小游戏应用

# 查看已接入的游戏
node src/build.js --list

# 构建单个游戏到四平台
node src/build.js snack-adventure

# 只构建某平台
node src/build.js snack-adventure --platform wechat

# 全量构建
node src/build.js --all

# 离线验证（无需真机）
node src/verify.js snack-adventure --platform wechat

# 生成浏览器预览页（可截图核对 UI）
node src/preview.js snack-adventure --platform wechat
```

产物位于 `dist/<game-id>/<platform>/`，可直接用对应平台的开发者工具打开。

---

## 二、四平台能力差异（关键）

完整勘查见 [`docs/platform-research.md`](./docs/platform-research.md)。

| 能力 | 微信 | 抖音 | 支付宝 | 京东 |
|------|------|------|--------|------|
| 命名空间 | `wx` | `tt` | `my` | `jd` |
| WebAudio 合成 | ✅ 2.19.0+ | ✅ 1.34.0+ | ❌ **无** | ❓ 探测 |
| 离屏 Canvas | ✅ | ✅ | ⚠️ 旧式 | ❓ 探测 |
| 同步存储 | ✅ | ✅ | ✅ | ✅ |
| 运行时横竖屏 | ✅ | ✅ | ❌ | ❓ 探测 |

**最重要的一条**：本合集所有游戏的音效都是 Web Audio **程序化合成**
（`OscillatorNode` / `GainNode` / `BiquadFilterNode`，零外部音频文件）。
微信与抖音完整支持，**支付宝官方 API 只有 `createInnerAudioContext`（播放音频文件）**，
因此在支付宝端音效会**降级为静音**——这是平台限制，不是转换缺陷。

若要在支付宝端保留音效，需在构建期把音色离线渲染为音频文件，
再用 `createInnerAudioContext` 播放（`runtime/mg-audio.js` 已预留钩子）。

---

## 三、目录结构

```
小游戏应用/
├── config/platforms.json      四平台能力矩阵（构建与运行时的事实来源）
├── runtime/                   适配层（会被打包进每个产物）
│   ├── mg-platform.js         平台探测 + 能力探测
│   ├── mg-storage.js          localStorage → 平台 Storage
│   ├── mg-canvas.js           Canvas 创建 / HiDPI / 原型补丁
│   ├── mg-audio.js            WebAudio 兼容 + 静音降级
│   ├── mg-input.js            触摸 → pointer/mouse/touch 扇出
│   ├── mg-ui-layout.js        CSS 子集布局引擎
│   ├── mg-ui-render.js        Canvas 渲染器
│   ├── mg-parser.js           HTML / CSS 解析
│   ├── mg-dom.js              虚拟 DOM + document 兼容
│   └── mg-lifecycle.js        主循环与前后台
├── src/
│   ├── build.js               构建器
│   ├── verify.js              离线验证器（Node 沙盒）
│   └── preview.js             浏览器预览壳（可截图）
├── games/<id>/game.config.json  每个游戏的接入配置
├── platform/                  四平台工程模板说明
├── docs/                      平台勘查 / 架构说明
└── dist/                      构建产物（不入库）
```

---

## 四、接入新游戏

1. 在 `games/` 下建目录，写 `game.config.json`：

```json
{
  "id": "my-game",
  "title": "我的游戏",
  "source": "my-game/my-game.html",
  "orientation": "portrait",
  "appid": {
    "wechat": "wx_xxx",
    "douyin": "tt_xxx",
    "alipay": "xxx",
    "jd": "jd_xxx"
  }
}
```

2. 构建并验证：

```bash
node src/build.js my-game
node src/verify.js my-game --platform wechat
```

3. 把 `dist/my-game/<platform>/` 导入对应开发者工具，填入真实 appid 即可。

---

## 五、当前状态

7 款游戏 × 4 平台 = **28 个产物全部构建并通过离线验证**（每款 42/42 项，合计 28 次组合全通过）。

已实测确认（Chrome 无头渲染）：
- 游戏本体 Canvas 绘制正常
- DOM 覆盖层 UI（HUD / 菜单 / 结算）由布局引擎还原
- 无 JS 运行时错误

### 已知限制

| 项 | 说明 |
|----|------|
| UI 布局精度 | 布局引擎覆盖 flex / absolute / 盒模型，个别复杂嵌套（多层 flex + gap + 对齐组合）会有偏移，视觉上需人工微调 |
| `backdrop-filter` | 不支持（毛玻璃效果丢失） |
| `box-shadow` | 不绘制（阴影丢失） |
| `@keyframes` 动画 | 不支持，元素无过渡动画 |
| `::before/::after` | 不支持（游戏里主要用于箭头等装饰） |
| 文字度量 | 无字体度量上下文，宽度为估算值，可能与浏览器有细微差异 |
| 微信键盘 | 真机无物理键盘，`keydown` 相关逻辑在真机不触发（游戏均已实现触摸操作，不影响可玩性） |

这些限制集中在 **DOM 覆盖层的视觉还原度**上，不影响游戏玩法逻辑。
彻底解决需要为每款游戏手写 Canvas UI，代价与收益需权衡。

---

## 六、设计约束

1. **不硬编码平台判断**——所有分支走 `mg-platform.js` 的能力探测。
2. **降级必须静默**——WebAudio 不可用时静音而非抛错（这类差异只在真机暴露）。
3. **解析逻辑单一来源**——构建期与运行期共用同一套 HTML/CSS 解析语义。
4. **改写最小化**——对游戏源码只做两处必要手术（移除 roundRect 补丁、移除外链字体），
   每次改写都会记录在产物的 `build-report.json` 里。
