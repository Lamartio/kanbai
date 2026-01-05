# Kanbai - AI Project Manager UI

A Kanban-style project management tool that puts you in the seat of a software project manager, organizing a team of AI agents as developers to build features through conversations with a Business Analyst AI agent.

## Overview

Kanbai provides a web-based UI where you can:
- Converse with a Business Analyst AI to define features
- Organize features on a Kanban board (TODO → DOING → REVIEWING → DONE)
- Manage AI developer agents to implement features
- Track progress through markdown files that are both human and AI readable

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Browser (Nuxt UI)                         │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  Kanban Board    │  Feature Details  │  AI Chat Interface   │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                              │ Actions                           │
└──────────────────────────────┼───────────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Nuxt Server (Bun)                            │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                    Effect-TS Runtime                         │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │ │
│  │  │ Action Layer │  │ Storage Layer│  │  AI Layer    │       │ │
│  │  └──────────────┘  └──────────────┘  └──────────────┘       │ │
│  └─────────────────────────────────────────────────────────────┘ │
└──────────────────────────────┼───────────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                   content/ (Nuxt Content)                        │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  XYZ-001-user-authentication.md                              │ │
│  │  XYZ-002-dashboard-widgets.md                                │ │
│  │  XYZ-ABC-001-admin-panel.md                                  │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### Core Concepts

#### Actions
The web client sends typed "action" objects to the server. These actions are processed by Effect-TS services, providing:
- Type-safe request/response handling
- Composable error handling
- Dependency injection via layers

#### Feature Files
Features are stored as markdown files with YAML frontmatter in the `content/` directory:

```markdown
---
id: XYZ-001
title: User Authentication
tags:
  - TODO
  - auth
  - priority-high
created: 2024-01-05
---

# User Authentication

## Description
Implement user authentication with email/password...
```

#### Feature ID Format
- Pattern: `[PROJECT]-[SUBPROJECT]-[NUMBER]`
- Examples: `XYZ-001`, `XYZ-ABC-001`, `PROJ-SUB-TEAM-042`
- Rule: Rightmost segment after `-` is always a zero-padded number
- The full ID is used in the frontmatter

#### Default Tags (Kanban Columns)
| Tag | Purpose |
|-----|---------|
| `TODO` | Features waiting to be started |
| `DOING` | Features currently in progress |
| `REVIEWING` | Features awaiting review |
| `DONE` | Completed features |

Tags must contain only URL-safe characters and are case-sensitive.

## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | [Bun](https://bun.sh) |
| Framework | [Nuxt 4](https://nuxt.com) |
| UI Components | [Nuxt UI](https://ui.nuxt.com) |
| Content Management | [Nuxt Content](https://content.nuxt.com) |
| Business Logic | [Effect-TS](https://effect.website) |
| AI Integration | [Effect AI](https://effect.website/blog/effect-ai/) |
| Environment | [mise-en-place](https://mise.jdx.dev) |

## MCP Servers

The project is configured with Model Context Protocol (MCP) servers for AI assistance:

| MCP Server | Purpose |
|------------|---------|
| [effect-mcp](https://github.com/tim-smart/effect-mcp) | Effect-TS documentation and patterns |
| [Nuxt MCP](https://nuxt.com/docs/4.x/guide/ai/mcp) | Nuxt framework guidance |
| [Nuxt UI MCP](https://ui.nuxt.com/docs/getting-started/ai/mcp) | Nuxt UI components |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) | Browser automation for testing |
| [Context7](https://github.com/upstash/context7) | Documentation context retrieval |

## Getting Started

### Prerequisites

```bash
# Install mise-en-place (environment manager)
curl https://mise.run | sh

# Install dependencies via mise
mise install

# Verify bun is available
bun --version
```

### Installation

```bash
# Install dependencies
bun install

# Run development server
bun run dev
```

### Environment Variables

```bash
# Required for Context7 MCP
export CONTEXT7_API_KEY="your-api-key"
```

## Project Structure

```
kanbai/
├── .mcp.json              # MCP server configuration
├── content/               # Feature markdown files (Nuxt Content)
│   ├── XYZ-001-*.md
│   └── ...
├── server/
│   ├── api/               # API routes
│   └── services/          # Effect-TS services
│       ├── actions/       # Action handlers
│       ├── storage/       # File system operations
│       └── ai/            # AI integration layer
├── components/            # Vue components
├── pages/                 # Nuxt pages
├── mise.toml              # Environment configuration
└── nuxt.config.ts         # Nuxt configuration
```

## Development

See [CLAUDE.md](./CLAUDE.md) for AI assistant guidelines and [AGENTS.md](./AGENTS.md) for the AI agents architecture.

## License

See [LICENSE](./LICENSE) for details.
