# AGENTS.md - AutoMate 项目指南

本文档为 AI 代理提供 AutoMate 项目的完整上下文和技术指南。

## 项目概述

**AutoMate** 是一个自托管的个人 AI 助手平台，采用 TypeScript 构建，支持多渠道接入、工具调用和插件扩展。该项目可在高性能服务器或 Android 平板（通过 Termux）上运行，代码量约 24K 行，追求精简、快速、无臃肿。

### 核心特性

- **多渠道支持** — Web UI、Discord、CLI 三种交互方式
- **30+ 内置工具** — Shell、文件操作、浏览器自动化、网络搜索、图像分析/生成、定时任务、后台进程、内存管理等
- **隐身浏览器** — 基于 Selenium + stealth 补丁的 Chrome 自动化，支持反机器人检测
- **插件系统** — 支持热重载的 JS 插件架构
- **持久化内存** — 双层系统：日志（journal）+ 精选内存（MEMORY.md），支持向量搜索
- **会话管理** — 多并发会话，独立工具状态，上下文压缩
- **子代理** — 可生成并行自主代理进行多任务处理
- **技能系统** — 热重载的 SKILL.md 文件，无需代码更改即可扩展能力
- **心跳系统** — 周期性自主检查，即使没有用户交互也能执行任务
- **画布功能** — 向 Web UI 实时推送 HTML、Markdown、代码或 JSON
- **目标管理** — 持久化目标队列系统，支持自主任务跟踪和执行
- **自主能力** — 自我评估、自我测试和元认知工具，实现智能反思和学习

## 技术栈

| 层级 | 技术 |
|------|------|
| 运行时 | Node.js 22+ |
| 语言 | TypeScript (ES2024, ESM) |
| 后端框架 | Fastify |
| 前端框架 | React 19 + Vite |
| 浏览器自动化 | Python + undetected-chromedriver + selenium-stealth |
| 配置验证 | Zod |
| WebSocket | @fastify/websocket |
| Discord | discord.js |
| 向量搜索 | 自定义混合搜索（向量 + BM25） |

## 目录结构

```
automate/
├── src/
│   ├── index.ts              # CLI 入口点 (Commander)
│   ├── agent/
│   │   ├── agent.ts          # 核心代理循环 — LLM 调用、工具执行、上下文管理
│   │   ├── llm-client.ts     # OpenAI 兼容客户端，支持流式传输、重试、故障转移
│   │   ├── tool-registry.ts  # 每会话工具加载、延迟初始化、策略执行
│   │   └── tools/            # 19 个内置工具定义
│   │       ├── bash.ts       # Shell 命令执行
│   │       ├── browser.ts    # 浏览器自动化
│   │       ├── cron.ts       # 定时任务
│   │       ├── files.ts      # 文件读写/编辑
│   │       ├── image.ts      # 图像分析/生成
│   │       ├── memory.ts     # 内存管理
│   │       ├── sessions.ts   # 会话管理
│   │       ├── subagent.ts   # 子代理
│   │       ├── web.ts        # 网络搜索/抓取
│   │       └── ...           # 其他工具
│   ├── browser/
│   │   └── engine.py         # Python 隐身浏览器引擎 (~2500 行)
│   ├── canvas/
│   │   └── canvas-manager.ts # 实时内容推送到 Web UI
│   ├── channels/
│   │   └── discord.ts        # Discord 频道集成
│   ├── clawhub/
│   │   └── registry.ts       # 社区技能注册表
│   ├── config/
│   │   ├── loader.ts         # 配置加载/保存/热重载
│   │   └── schema.ts         # Zod 配置 Schema
│   ├── cron/
│   │   └── scheduler.ts      # Cron 任务调度器
│   ├── gateway/
│   │   ├── server.ts         # Fastify 服务器 — REST API、WebSocket、静态文件
│   │   ├── session-manager.ts # 多会话支持
│   │   ├── context-pruner.ts  # 上下文修剪
│   │   └── presence.ts        # 在线状态管理
│   ├── heartbeat/
│   │   └── manager.ts        # 周期性自主代理检查
│   ├── memory/
│   │   ├── manager.ts        # 内存管理器 — 日志 + 精选内存
│   │   ├── vector-index.ts   # 混合搜索（向量 + BM25）
│   │   └── defaults/         # 默认模板文件
│   │       ├── AGENTS.md     # 代理操作指令
│   │       ├── PERSONALITY.md # 人格设定
│   │       ├── USER.md       # 用户信息
│   │       └── ...
│   ├── plugins/
│   │   └── manager.ts        # 插件 SDK — 工具、频道、中间件、热重载
│   ├── skills/
│   │   └── loader.ts         # SKILL.md 热重载、ClawHub 集成
│   └── agents/
│       └── router.ts         # 多代理路由
├── ui/                       # React Web UI
│   ├── src/
│   │   ├── App.tsx
│   │   ├── pages/            # 各页面组件
│   │   │   ├── Chat.tsx      # 多会话聊天
│   │   │   ├── Memory.tsx    # 内存浏览/编辑
│   │   │   ├── Sessions.tsx  # 会话管理
│   │   │   ├── Skills.tsx    # 技能管理
│   │   │   ├── Plugins.tsx   # 插件管理
│   │   │   ├── Cron.tsx      # 定时任务
│   │   │   ├── Canvas.tsx    # 实时内容展示
│   │   │   └── ...
│   │   └── hooks/
│   └── package.json
├── bin/
│   └── automate.mjs          # CLI 二进制入口
├── skills/                   # 默认技能目录
├── tests/                    # 测试套件
└── automate.example.json     # 配置示例
```

## 构建与运行

### 安装

```bash
git clone https://github.com/supastishn/automate.git
cd automate
npm install

# 构建 Web UI
cd ui && npm install && npm run build && cd ..
```

### 配置

```bash
# 复制示例配置
cp automate.example.json ~/.automate/automate.json

# 编辑配置
nano ~/.automate/automate.json
```

最小配置只需设置模型和 API 端点：

```json
{
  "agent": {
    "model": "claude-sonnet-4-20250514",
    "apiBase": "https://api.openai.com/v1",
    "apiKey": "sk-..."
  }
}
```

支持任何 OpenAI 兼容 API：OpenAI、Anthropic（通过代理）、Ollama、LM Studio、Together、Groq 等。

### 运行命令

```bash
# 启动 Gateway（Web UI + API）
npm run gateway

# 开发模式（tsx 直接运行）
npm run dev

# CLI 聊天模式
npm run dev chat

# 网关状态检查
npm run dev status

# 显示配置
npm run dev config

# 安全审计
npm run dev doctor

# 恢复出厂设置
npm run dev factory-reset

# ClawHub 技能管理
npm run dev clawhub browse
npm run dev clawhub search <query>
npm run dev clawhub install <repo>
npm run dev clawhub uninstall <name>
npm run dev clawhub update [name]
npm run dev clawhub list
```

### 测试

```bash
# 运行所有测试
npm test

# 单独测试模块
npm run test:config
npm run test:memory
npm run test:sessions
npm run test:cron
npm run test:tools
npm run test:gateway
npm run test:system
npm run test:agent
```

### 构建

```bash
# 编译 TypeScript
npm run build

# 从编译产物运行
npm start
```

## 核心架构

### 代理循环 (`src/agent/agent.ts`)

核心代理类负责：
- LLM 调用（流式/非流式）
- 工具执行和结果处理
- 上下文管理（系统提示、技能注入、内存注入）
- 权限提升状态跟踪
- 中断支持（AbortController）
- 消息队列处理

关键方法：
- `processMessage(sessionId, message, onStream, onToolCall)` — 处理用户消息
- `handleCommand(sessionId, command)` — 处理斜杠命令
- `updateConfig(config)` — 热更新配置
- `_rebuildSystemContent(sessionView, sessionId)` — 重建系统提示

### 工具注册表 (`src/agent/tool-registry.ts`)

支持延迟加载的工具管理：
- 核心工具（始终加载）：bash、read_file、write_file、hashline_edit、memory
- 延迟加载工具：browser、web、image、subagent、session、cron 等
- 工具策略（allow/deny 列表）
- 每会话独立工具视图

### LLM 客户端 (`src/agent/llm-client.ts`)

OpenAI 兼容客户端特性：
- 流式和非流式响应
- 多提供商故障转移
- 重试和冷却机制
- 模型别名支持
- 负载均衡
- 速率限制

### 网关服务器 (`src/gateway/server.ts`)

Fastify 服务器提供：
- REST API（会话、配置、聊天、画布、上传等）
- WebSocket（实时聊天和画布更新）
- OpenAI 兼容 API（`/v1/chat/completions`、`/v1/models`）
- 静态文件服务（UI）
- 认证中间件

### 会话管理 (`src/gateway/session-manager.ts`)

多会话支持：
- 独立的消息历史
- 上下文压缩（自动/手动）
- 上下文修剪（工具结果修剪）
- 会话持久化
- 主会话跟踪

### 内存管理 (`src/memory/manager.ts`)

双层内存系统：

**Tier 1 - 核心内存**（始终注入系统提示）
- `MEMORY.md` — 硬限制 ~8000 字符
- 仅存储核心信息：身份、用户、活跃上下文

**Tier 2 - 参考内存**（按需加载）
- `memory/` 子目录 — 主题文件
- `logs/` 子目录 — 日志（YYYY-MM-DD.md）

功能：
- 向量搜索（OpenAI/Gemini/Voyage/本地嵌入）
- 混合搜索（向量 + BM25）
- 热重载

### 浏览器引擎 (`src/browser/engine.py`)

Python 实现的隐身浏览器：
- 反机器人检测（undetected-chromedriver + selenium-stealth）
- 完整的自动化能力（导航、点击、输入、截图、JS 执行等）
- 网络请求拦截
- Shadow DOM 遍历
- 地理位置伪造
- PDF 生成
- 多标签管理

### 插件系统 (`src/plugins/manager.ts`)

插件 SDK 提供：
- 工具扩展
- 新频道集成
- 中间件拦截
- 生命周期钩子
- 热重载

插件结构：
```
~/.automate/plugins/
└── my-plugin/
    ├── plugin.json      # 清单
    ├── index.js         # 入口
    └── config.json      # 可选配置
```

## 工具清单

### 始终可用
| 工具 | 描述 |
|------|------|
| `bash` | 执行 Shell 命令 |
| `read_file` | 读取文件（带行哈希用于精确编辑） |
| `write_file` | 写入/创建文件 |
| `hashline_edit` | 基于行哈希的编辑 |
| `memory` | 搜索、读取、写入内存 |
| `list_tools` | 列出可用和已加载的工具 |
| `load_tool` / `unload_tool` | 延迟加载/卸载工具 |

### 按需加载
| 工具 | 描述 |
|------|------|
| `browser` | 隐身 Chrome — 导航、点击、输入、截图、JS 执行 |
| `web` | 网络搜索（Brave API）+ URL 抓取/抓取 |
| `image` | 视觉（分析图像）、DALL-E 生成、发送到聊天 |
| `subagent` | 生成并行子代理 |
| `session` | 管理会话 |
| `cron` | 调度循环任务 |
| `process` | 启动/管理后台进程 |
| `canvas` | 向 Web UI 推送富内容 |
| `skill` | 创建/管理 SKILL.md 文件 |
| `shared_memory` | 跨会话持久状态 |
| `plugin` | 创建、管理、重载插件 |

## 配置参考

完整配置示例：

```json
{
  "agent": {
    "model": "claude-opus-4.6",
    "apiBase": "http://localhost:4141/v1",
    "apiKey": "sk-...",
    "maxTokens": 8192,
    "temperature": 0.3,
    "thinkingLevel": "off",
    "systemPrompt": "...",
    "providers": [/* 故障转移提供商 */],
    "aliases": [/* 模型别名 */],
    "powerSteering": { "enabled": true, "interval": 25 },
    "subagent": { "defaultModel": "...", "useParentApiKey": true },
    "loadBalancing": { "enabled": false },
    "rateLimit": { "enabled": false }
  },
  "agents": [/* 多代理配置 */],
  "gateway": {
    "port": 18789,
    "host": "127.0.0.1",
    "auth": { "mode": "none" }
  },
  "channels": {
    "discord": { "enabled": false, "token": "", "allowFrom": ["*"] }
  },
  "browser": { "enabled": true, "headless": false },
  "skills": { "directory": "~/.automate/skills" },
  "memory": {
    "directory": "~/.automate/memory",
    "embedding": { "enabled": true, "provider": "openai" }
  },
  "cron": { "enabled": true, "directory": "~/.automate/cron" },
  "tools": { "allow": [], "deny": [], "deferredLoading": true },
  "sessions": {
    "directory": "~/.automate/sessions",
    "contextLimit": 120000,
    "compactAt": 0.8,
    "pruning": { "enabled": true }
  },
  "canvas": { "enabled": true },
  "plugins": { "enabled": true, "directory": "~/.automate/plugins" },
  "heartbeat": { "enabled": false, "intervalMinutes": 30 }
}
```

## 开发规范

### 代码风格

- 使用 `const` 和 `let`，不使用 `var`
- 箭头函数用于回调
- async/await 优于 Promise
- 模板字符串用于字符串插值
- 函数式方法（map、filter、reduce）优于循环
- 文件名：kebab-case（如 `content-type-parser.js`）
- 变量名：camelCase
- 常量：UPPER_SNAKE_CASE
- 类名：PascalCase

### TypeScript 配置

- 目标：ES2024
- 模块：NodeNext
- 严格模式
- ESM 输出

### 注释原则

- 仅在必要时添加注释
- 解释"为什么"而非"是什么"
- 不在注释中与用户对话

## 环境变量

| 变量 | 描述 |
|------|------|
| `OPENAI_API_KEY` | OpenAI 兼容端点的默认 API 密钥 |
| `BRAVE_API_KEY` | 网络搜索工具 |
| `FIRECRAWL_API_KEY` | 高级网络抓取 |
| `GEMINI_API_KEY` | Google AI 模型 |

## Termux (Android) 运行

```bash
# 安装依赖
pkg install nodejs python

# 克隆并安装
git clone https://github.com/supastishn/automate.git
cd automate && npm install

# 浏览器自动化
pip install -r src/browser/requirements.txt
pkg install chromium x11-repo xorg-server-xvfb

# 运行
npm run gateway
```

## API 端点

### REST API

| 端点 | 方法 | 描述 |
|------|------|------|
| `/api/health` | GET | 健康检查 |
| `/api/sessions` | GET | 列出所有会话 |
| `/api/sessions/:id` | GET/DELETE | 获取/删除会话 |
| `/api/sessions/:id/context` | GET | 获取完整上下文 |
| `/api/sessions/:id/messages` | PUT | 更新会话消息 |
| `/api/sessions/:id/duplicate` | POST | 复制会话 |
| `/api/sessions/:id/export` | GET | 导出会话为 JSON |
| `/api/sessions/import` | POST | 从 JSON 导入会话 |
| `/api/config` | GET/PUT | 读取/更新配置 |
| `/api/config/full` | GET | 完整配置（敏感字段已遮蔽） |
| `/api/chat` | POST | 发送消息（非流式） |
| `/api/status` | GET | 网关状态 |
| `/api/canvas` | GET | 列出所有画布 |
| `/api/upload` | POST | 文件上传 |

### OpenAI 兼容 API

| 端点 | 方法 | 描述 |
|------|------|------|
| `/v1/chat/completions` | POST | 聊天补全（流式/非流式） |
| `/v1/models` | GET | 列出可用模型 |

### WebSocket

| 端点 | 描述 |
|------|------|
| `/ws` | 聊天 WebSocket |
| `/ws/canvas` | 画布 WebSocket |

## 常见任务

### 添加新工具

1. 在 `src/agent/tools/` 创建新文件
2. 定义工具对象（name、description、parameters、execute）
3. 在 `src/agent/agent.ts` 中注册工具
4. 如需延迟加载，使用 `registerTool()` 辅助函数

### 添加新频道

1. 在 `src/channels/` 创建新文件
2. 实现 `start()` 和 `stop()` 方法
3. 在 `src/index.ts` 中集成

### 添加插件

1. 在 `~/.automate/plugins/` 创建目录
2. 创建 `plugin.json` 清单
3. 创建 `index.js` 入口文件
4. 导出 `activate(ctx)` 函数

### 调试

```bash
# 启用详细日志
npm run gateway -- --verbose

# 检查网关状态
curl http://127.0.0.1:18789/api/health

# 检查会话状态
curl http://127.0.0.1:18789/api/sessions
```

## 故障排除

### 网关无法启动

- 检查端口是否被占用：`lsof -i :18789`
- 检查配置文件语法：`npm run dev config`
- 运行诊断：`npm run dev doctor`

### 浏览器自动化失败

- 确保安装了 Python 依赖：`pip install -r src/browser/requirements.txt`
- 检查 Chrome/Chromium 是否安装
- 检查 DISPLAY 环境变量（如需要）

### 内存搜索不工作

- 检查嵌入配置是否正确
- 确保有网络连接（如使用远程嵌入服务）
- 尝试重新索引：通过内存工具

## 许可证

MIT — 可自由使用和修改。

---

*由一位来自巴勒斯坦的 13 岁开发者构建，在图勒凯尔姆的平板上运行。*
