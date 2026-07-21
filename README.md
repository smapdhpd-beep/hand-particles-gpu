# hand-particles-gpu

基于 GPU 的大规模手势控制粒子系统。6.5 万粒子在手中流动，支持 5 种力场预设。

## 功能亮点

- **6.5 万 GPU 粒子**：256×256 纹理，Three.js GPUComputationRenderer 并行模拟
- **手势切换力场**：捏合/张开/数字 1/2/3 切换不同物理行为
- **5 种力场预设**：引力奇点 / 涡旋 / 排斥 / 布朗运动 / 简谐震荡
- **发光粒子渲染**：AdditiveBlending + 自定义 ShaderMaterial
- **MediaPipe Hands**：原生 getUserMedia 手势追踪
- **零外部依赖**：Three.js + MediaPipe 通过 CDN 加载，无构建工具

## 手势映射

| 手势 | 力场效果 |
|------|----------|
| 默认/放松 | 涡旋 |
| 拇指+食指捏合 | 引力奇点 |
| 比 1 | 排斥 |
| 比 2 | 布朗运动 |
| 比 3 | 简谐震荡 |

## 技术栈

- **Three.js** (ES Module) — WebGL 渲染
- **GPUComputationRenderer** — GPU 粒子物理模拟
- **MediaPipe Hands** (CDN 全局变量) — 手势追踪
- **Vanilla JS** — 无框架、无构建工具

## 快速开始

```bash
python3 -m http.server 8080
# 浏览器打开 http://localhost:8080
```

> 必须使用 HTTP 服务器运行，file:// 协议会因 CORS 阻止 ES Module 加载。

## 文档目录

| 文件 | 内容 |
|------|------|
| [`docs/01-项目概述.md`](docs/01-项目概述.md) | 项目灵感、核心体验、当前功能、技术架构 |
| [`docs/07-使用手册.md`](docs/07-使用手册.md) | 用户操作指南与故障排查 |

## 注意事项

- 需要 WebGL 2.0 支持
- 首次加载 MediaPipe WASM 模型需要 3~8 秒
- 需要在 HTTPS 或 localhost 环境运行（摄像头要求）

## Credits

- **项目发起**：基于手势交互粒子可视化灵感
- **代码实现**：Claude (Anthropic)
