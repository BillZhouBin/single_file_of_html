# platform/ — 四平台工程模板

构建产物 `dist/<game>/<platform>/` 下的文件结构与各平台要求如下。
这些文件由 `src/build.js` 生成，本目录记录各平台的手工注意事项。

## 生成的文件

| 文件 | 说明 |
|------|------|
| `game.js` | 适配层 + 游戏代码（单文件，平台加载入口） |
| `game.json` | 平台主配置（方向、超时、分包） |
| `project.config.json` / `mini.app.json` | 开发者工具工程配置（含 appid） |
| `game.entry.js` | 显式入口，`require('./game.js')` |
| `build-report.json` | 构建诊断：能力探测结果、改写记录、包体大小 |

## 微信小游戏

- 工程配置：`project.config.json`，`compileType: "game"`，`libVersion` 建议 ≥ `2.19.0`。
- `wx.createWebAudioContext()` 需基础库 2.19.0+；低版本会自动降级为静音。
- 上屏 canvas 只有一个，`createCanvas()` **首次调用**的返回值就是上屏画布。
- 主包 ≤ 4MB，分包总计 ≤ 20MB。

## 抖音小游戏

- 同样使用 `project.config.json`，`compileType: "game"`。
- WebAudio 走 `tt.getAudioContext()`（**同步**方法，与微信的 `createWebAudioContext` 命名不同）。
- 采样率仅支持 44.1k / 22.05k / 11.025k / 8k / 16k / 24k / 32k / 48k Hz。

## 支付宝小游戏

- 工程配置为 **`mini.app.json`**（与其他三家不同）。
- **无 WebAudio**：官方 API 总览的音频项只有 `my.createInnerAudioContext`。
  音效会降级为静音，这是平台限制。
- 画布接口为 `my.createCanvasContext`（旧式命令队列，需 `draw()` 提交），
  与 `getContext('2d')` 的实时上下文语义不同。适配层已做能力探测与 draw() 补齐。
- **不支持 `setDeviceOrientation`**：横竖屏需按设计固定。
  `grass-survivor`（一骑当千）为横屏游戏，在支付宝端需按竖屏或固定横屏处理。

## 京东小游戏

- 容器与微信小游戏同源，API 命名对齐 `jd.*`。
- 公开文档未明确 WebAudio / 离屏 canvas 支持情况，因此适配层对该平台的
  增强能力**一律走运行时探测**，探测失败即降级。
- 分包总计 ≤ 16MB（比微信略小）。
- 平台处于**邀请制**，需在京东开放平台申请接入资格。

## 导入方式

| 平台 | 导入 |
|------|------|
| 微信 | 微信开发者工具 → 导入项目 → 选 `dist/<game>/wechat` 目录 |
| 抖音 | 抖音开发者工具 → 导入项目 → 选 `dist/<game>/douyin` 目录 |
| 支付宝 | 支付宝开发者工具 → 导入项目 → 选 `dist/<game>/alipay` 目录 |
| 京东 | 京东开发者工具 → 导入项目 → 选 `dist/<game>/jd` 目录 |

导入后需把 `project.config.json` 里的 `appid` 替换为后台申请到的真实值。
