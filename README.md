# hand-particles-gpu

基于 GPU 的大规模手势控制粒子系统。目标：突破 8,000 粒子上限，实现 10万~50万 粒子的手势驱动星云效果。

## 愿景

- 手作为引力奇点，在星云中扫出螺旋吸积盘
- 多种力场预设：涡旋、排斥、布朗运动、简谐震荡
- 粒子带拖尾，形态物理流动
- 从星云流入爱心，不是硬切

## 技术栈

- **Three.js** (ES Module) — WebGL 渲染
- **GPUComputationRenderer** — GPU 粒子物理模拟
- **MediaPipe Hands** — 手势追踪
- **Vanilla JS** — 无框架、无构建工具

## 快速开始

```bash
python3 -m http.server 8080
# 浏览器打开 http://localhost:8080
```

## 文档目录

| 文件 | 内容 |
|------|------|
| [`docs/01-项目概述.md`](docs/01-项目概述.md) | 项目灵感、核心体验、当前功能、技术架构 |
| [`docs/07-使用手册.md`](docs/07-使用手册.md) | 用户操作指南 |

## 状态

项目骨架已创建，核心 GPU 粒子系统待实现。
