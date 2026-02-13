<p align="center">
  <h1 align="center">⚡ AutoMate</h1>
  <p align="center">Self-hosted personal AI agent. Multi-channel, tool-using, plugin-extensible.</p>
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#tools">Tools</a> •
  <a href="#plugins">Plugins</a> •
  <a href="#web-ui">Web UI</a> •
  <a href="#configuration">Configuration</a>
</p>

---

AutoMate is a personal AI assistant platform that runs on your own hardware. Connect any OpenAI-compatible LLM, give it tools (shell, browser, files, web search, etc.), and let it work for you across Discord, the web UI, or the CLI.

Built in TypeScript. Runs on anything from a beefy server to an Android tablet via Termux. ~24K lines of code — lean, fast, no bloat.

## Features

- **Multi-channel** — Web UI, Discord, CLI. Talk to your agent from anywhere.
- **30+ built-in tools** — Shell, file ops, browser automation, web search, image analysis/generation, cron jobs, background processes, memory, and more.
- **Stealth browser** — Undetected Chrome via Selenium + stealth patches. Bot-proof web automation with human-like typing, clicking, and navigation.
- **Plugin system** — Drop a JS file in a folder, get new tools instantly. Hot-reload, config schemas, lifecycle hooks.
- **Persistent memory** — Two-layer system: daily logs (journal) + curated MEMORY.md (long-term brain). Vector search across all memory.
- **Session management** — Multiple concurrent sessions with independent tool states. Context compaction when conversations get long.
- **Sub-agents** — Spawn parallel autonomous agents for multitasking. Blocking or fire-and-forget modes.
- **Skills** — Hot-reloadable SKILL.md files that teach the agent new capabilities without code changes.
- **ClawHub** — Browse and install community skills from the registry.
- **Heartbeat system** — Periodic autonomous check-ins. Your agent does work even when you're not talking to it.
- **Canvas** — Push HTML, Markdown, code, or JSON to the web UI in real-time. Great for dashboards, games, visualizations.
- **Multi-agent** — Run multiple agents with different personalities, models, and tool access.

## Quick Start

### Prerequisites

- **Node.js** 22+ 
- An **OpenAI-compatible API** endpoint (OpenAI, Anthropic via proxy, Ollama, LM Studio, etc.)
- Optional: Python 3.10+ for browser automation, Chrome/Chromium for stealth browsing

### Install

```bash
git clone https://github.com/supastishn/automate.git
cd automate
npm install

# Build the web UI
cd ui && npm install && npm run build && cd ..
```

### Configure

```bash
# Copy the example config
cp automate.example.json ~/.automate/automate.json

# Edit with your API details
nano ~/.automate/automate.json
```

Minimal config — just set your model and API endpoint:

```json
{
  "agent": {
    "model": "claude-sonnet-4-20250514",
    "apiBase": "https://api.openai.com/v1",
    "apiKey": "sk-..."
  }
}
```

Works with any OpenAI-compatible API: OpenAI, Anthropic (via proxy), Ollama (`http://localhost:11434/v1`), LM Studio, Together, Groq, etc.

### Run

```bash
# Start the gateway (web UI + API)
npm run gateway

# Or run directly with tsx
npm run dev
```

Open `http://localhost:18789` in your browser. That's it.

### First Run

On first launch, AutoMate runs an onboarding wizard:
1. Pick a name for your agent
2. Set the vibe — personality, tone, emoji
3. Tell it about yourself

Everything is stored in `~/.automate/` — memory files, sessions, skills, plugins, config.

## Architecture

```
┌──────────────────────────────────────────────────┐
│                   Gateway (Fastify)               │
│         REST API + WebSocket + Static UI          │
├──────────┬──────────┬──────────┬─────────────────┤
│  Web UI  │ Discord  │   CLI    │  Plugin Channels │
│(WebSocket)│(discord.js)│(stdin)│                  │
├──────────┴──────────┴──────────┴─────────────────┤
│                    Agent Core                     │
│         LLM Client ↔ Tool Registry ↔ Memory      │
├──────────────────────────────────────────────────┤
│                  Tool Layer                        │
│  bash │ files │ browser │ web │ image │ cron │ ...│
├──────────────────────────────────────────────────┤
│               Plugin Manager                      │
│     Hot-reload │ Config │ Lifecycle │ Events      │
└──────────────────────────────────────────────────┘
```

### Key Components

| Component | Path | Description |
|-----------|------|-------------|
| Agent | `src/agent/agent.ts` | Core agent loop — LLM calls, tool execution, context management |
| Tool Registry | `src/agent/tool-registry.ts` | Per-session tool loading, lazy initialization, policy enforcement |
| LLM Client | `src/agent/llm-client.ts` | OpenAI-compatible client with streaming, retries, provider fallback |
| Gateway | `src/gateway/server.ts` | Fastify server — REST API, WebSocket, static file serving |
| Sessions | `src/gateway/session-manager.ts` | Multi-session support with independent tool states and context |
| Memory | `src/memory/manager.ts` | Two-layer memory: daily logs + curated MEMORY.md |
| Vector Index | `src/memory/vector-index.ts` | Hybrid search (vector + BM25) across all memory files |
| Browser | `src/browser/engine.py` | Python-based stealth browser with undetected-chromedriver |
| Plugins | `src/plugins/manager.ts` | Plugin SDK — tools, channels, middleware, hot-reload |
| Skills | `src/skills/loader.ts` | SKILL.md hot-reload, ClawHub registry integration |
| Heartbeat | `src/heartbeat/manager.ts` | Periodic autonomous agent check-ins |
| Cron | `src/cron/scheduler.ts` | Cron-based task scheduling |
| Canvas | `src/canvas/canvas-manager.ts` | Real-time content push to web UI |

## Tools

AutoMate ships with 30+ tools, lazy-loaded per session:

### Always Available
| Tool | Description |
|------|-------------|
| `bash` | Run shell commands |
| `read_file` | Read files with line hashes for precise editing |
| `write_file` | Write/create files |
| `edit_file` | Find-and-replace editing |
| `hashline_edit` | Line-hash-based editing (more reliable than string matching) |
| `apply_patch` | Apply unified diff patches |
| `memory` | Search, read, write memory — daily logs and curated memory |
| `identity` | Read/write personality, identity, and user files |
| `list_tools` | List all available and loaded tools |
| `load_tool` / `unload_tool` | Lazy-load tools on demand |

### On-Demand (load with `load_tool`)
| Tool | Description |
|------|-------------|
| `browser` | Stealth Chrome — navigate, click, type, screenshot, JS execution, form filling |
| `web` | Web search (Brave API) + URL fetch/scrape |
| `image` | Vision (analyze images), DALL-E generation, send to chat |
| `subagent` | Spawn parallel sub-agents for multitasking |
| `session` | Manage sessions — list, view history, send messages, spawn sub-sessions |
| `cron` | Schedule recurring tasks |
| `process` | Start/manage background processes |
| `canvas` | Push rich content (HTML/Markdown/code) to web UI |
| `skill` | Create/manage SKILL.md capability files |
| `shared_memory` | Cross-session persistent state |
| `message` | Send messages to other sessions or broadcast |
| `gateway` | View/patch gateway config at runtime |
| `plugin` | Create, manage, reload plugins |

### Browser Tool

The browser is a standout feature — a persistent Python process running undetected Chrome with stealth patches:

```
Actions: navigate, screenshot, click, type, find, scroll, 
         get_page, get_html, execute_js, fill_form, select,
         wait_element, press_key, human_click, human_type,
         click_text, find_text, get_interactive, get_aria_tree,
         upload, close, get_cookies, set_cookie, delete_cookie,
         set_device
```

- **`human_type`** — Types character-by-character with realistic timing. Supports inline key commands: `/enter`, `/tab`, `/escape`, `/backspace`.
- **`click_text`** / **`find_text`** — Find and click elements by visible text or aria-label. No CSS selectors needed.
- **`get_interactive`** — Lists all clickable elements with labels and positions.
- **`get_aria_tree`** — Compact accessibility tree snapshot for SPA navigation.

## Plugins

Drop a folder in `~/.automate/plugins/` with a `plugin.json` manifest and an `index.js`:

```
~/.automate/plugins/
└── my-plugin/
    ├── plugin.json
    ├── index.js
    └── config.json (optional)
```

**plugin.json:**
```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "Does cool things",
  "type": "tools",
  "entry": "index.js"
}
```

**index.js:**
```javascript
export function activate(ctx) {
  return {
    tools: [{
      name: 'my_tool',
      description: 'Does a cool thing',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['do', 'undo'] }
        },
        required: ['action']
      },
      async execute(params) {
        return { output: `Did the thing: ${params.action}` };
      }
    }]
  };
}

export function deactivate() {}
```

Plugin types: `tools` (add new tools), `channel` (new input channels), `middleware` (intercept messages), `mixed` (all of the above).

Plugins hot-reload on file changes — no restart needed.

### Plugin Context

Plugins receive a context object with:
- `pluginConfig` — Plugin-specific config from `config.json`
- `services.memory` — Memory manager
- `services.sessions` — Session manager  
- `services.scheduler` — Cron scheduler
- `services.agent` — Agent instance (for injecting messages into sessions)
- `log(message)` — Plugin logger

## Web UI

AutoMate includes a full web UI built with React + Vite:

- **Chat** — Multi-session chat with streaming, tool call display, file attachments
- **Dashboard** — System health, agent status, active sessions
- **Memory** — Browse and edit memory files, search across all memory
- **Sessions** — View all sessions, inspect message history, JSON editor
- **Skills** — Manage SKILL.md files, browse ClawHub registry
- **Plugins** — View loaded plugins, manage config
- **Cron** — View and manage scheduled jobs
- **Canvas** — Real-time content display (HTML, Markdown, code)
- **Settings** — Agent config, model settings, gateway options
- **Doctor** — System diagnostics and health checks

## Configuration

Full config reference (`~/.automate/automate.json`):

```json
{
  "agent": {
    "model": "claude-sonnet-4-20250514",
    "apiBase": "https://api.openai.com/v1",
    "apiKey": "sk-...",
    "maxTokens": 8192,
    "temperature": 0.3,
    "systemPrompt": "You are AutoMate, a fast and capable personal AI assistant.",
    "providers": [
      {
        "name": "fallback",
        "model": "gpt-4o",
        "apiBase": "https://api.openai.com/v1",
        "apiKey": "sk-...",
        "priority": 10
      }
    ]
  },
  "gateway": {
    "port": 18789,
    "host": "127.0.0.1",
    "auth": { "mode": "none" }
  },
  "channels": {
    "discord": {
      "enabled": false,
      "token": "",
      "allowFrom": ["*"]
    }
  },
  "browser": {
    "enabled": true,
    "headless": false,
    "profileDir": "~/.automate/chrome-profile"
  },
  "sessions": {
    "maxHistory": 200,
    "compactThreshold": 150
  },
  "plugins": {
    "enabled": true,
    "directory": "~/.automate/plugins"
  },
  "skills": {
    "directory": "~/.automate/skills"
  },
  "canvas": {
    "enabled": true
  }
}
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | Default API key for OpenAI-compatible endpoints |
| `BRAVE_API_KEY` | For web search tool |
| `FIRECRAWL_API_KEY` | For advanced web scraping |
| `GEMINI_API_KEY` | For Google AI models |

## Running on Termux (Android)

AutoMate was built and tested on Android via Termux. Here's how:

```bash
# Install dependencies
pkg install nodejs python

# Clone and install
git clone https://github.com/supastishn/automate.git
cd automate && npm install

# For browser automation
pip install -r src/browser/requirements.txt
pkg install chromium x11-repo xorg-server-xvfb

# Run
npm run gateway
```

## Project Structure

```
automate/
├── src/
│   ├── agent/          # Core agent, tool registry, LLM client
│   │   └── tools/      # 15+ built-in tool definitions
│   ├── browser/        # Python stealth browser engine
│   ├── canvas/         # Real-time content push
│   ├── channels/       # Discord channel
│   ├── clawhub/        # Community skill registry
│   ├── config/         # Config schema and loader
│   ├── cron/           # Task scheduler
│   ├── gateway/        # Fastify server, sessions, WebSocket
│   ├── heartbeat/      # Autonomous periodic checks
│   ├── memory/         # Memory manager + vector search
│   ├── onboard/        # First-run setup wizard
│   ├── plugins/        # Plugin SDK and manager
│   ├── skills/         # Skill loader
│   └── agents/         # Multi-agent router
├── ui/                 # React web UI (Vite)
│   └── src/pages/      # Dashboard, Chat, Memory, Sessions, etc.
├── bin/                # CLI entry point
├── skills/             # Default skills
├── tests/              # Test suite
└── automate.example.json
```

## Comparison with OpenClaw

AutoMate was built after seeing [OpenClaw](https://github.com/psteinberger/openclaw) blow up — it's a similar concept but built independently with different priorities:

| | AutoMate | OpenClaw |
|---|---|---|
| **Language** | TypeScript | TypeScript |
| **Codebase** | ~24K lines | ~60K+ lines |
| **Browser** | Custom stealth engine (Python + undetected-chromedriver) | Playwright-based |
| **Plugins** | Hot-reloadable JS plugins with config schemas | MCP-based tool system |
| **Memory** | Two-layer (daily logs + curated) with vector search | File-based memory |
| **UI** | Built-in React web UI | Web UI |
| **Channels** | Discord, Web UI, CLI, plugin channels | Discord, Telegram, Slack, etc. |
| **Focus** | Lean, personal, runs on low-end hardware | Feature-rich, community-driven |

Both are great. OpenClaw has a bigger community and more integrations. AutoMate is leaner and more hackable.

## Contributing

Issues and PRs welcome. This is a personal project but I'm happy to have people use it, break it, and make it better.

## License

MIT — do whatever you want with it.

---

*Built with ⚡ by a 13-year-old from Palestine, running on a tablet in Tulkarm.*
