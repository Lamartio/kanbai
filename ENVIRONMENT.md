# Environment Setup & Considerations

This document answers key questions about the Kanbai development environment.

## Q: Do we need to provide this environment with Chrome for Playwright?

**Yes, Chrome (or Chromium) needs to be installed for Playwright.**

Playwright MCP uses browser automation and requires browser binaries. Options:

### Option 1: Install via Playwright CLI (Recommended)
```bash
# Install only Chromium (smallest footprint)
bunx playwright install chromium

# Or install all browsers
bunx playwright install
```

### Option 2: System Chrome
If Chrome is already installed on the system, Playwright can use it:
```typescript
// playwright.config.ts
export default {
  use: {
    channel: 'chrome', // Use installed Chrome
  },
}
```

### Option 3: Container with Browser
For containerized deployments, use a Playwright Docker image:
```dockerfile
FROM mcr.microsoft.com/playwright:v1.40.0-jammy
```

**Recommendation**: Use `bunx playwright install chromium` during setup. It's isolated and doesn't conflict with system packages.

---

## Q: What environment are we running actually?

**Current Environment:**
- **OS**: Linux (kernel 4.4.0)
- **Platform**: Cloud/container environment
- **Shell**: Bash

**Target Development Environment:**
- **Runtime**: Bun (latest) - JavaScript/TypeScript runtime
- **Node**: v22 (for tooling compatibility)
- **Package Manager**: Bun's built-in package manager
- **Process Manager**: Bun's built-in dev server

**Production Environment (Recommended):**
- Bun runtime in a container (Alpine or Debian-based)
- Nuxt in SSR mode or static generation
- Optional: Edge deployment (Cloudflare Workers, Vercel Edge)

---

## Q: How about setting up mise-en-place for our environment dependencies?

**Yes, mise-en-place is configured!** See `mise.toml` in the project root.

### Setup Instructions

```bash
# 1. Install mise (if not already installed)
curl https://mise.run | sh

# 2. Add to shell (one-time)
echo 'eval "$(mise activate bash)"' >> ~/.bashrc
# or for zsh:
echo 'eval "$(mise activate zsh)"' >> ~/.zshrc

# 3. Restart shell or source the profile
source ~/.bashrc

# 4. Install project tools
cd /path/to/kanbai
mise install

# 5. Verify
bun --version  # Should show Bun version
node --version # Should show v22.x
```

### What mise manages for us:
- **Bun**: Primary runtime
- **Node.js**: Required for some tooling (Nuxt DevTools, etc.)
- **Tasks**: Common commands (dev, build, test, etc.)

### Using mise tasks:
```bash
mise run dev        # Start dev server
mise run build      # Build for production
mise run test       # Run tests
mise run playwright-install  # Install browser for tests
```

---

## Q: Can we setup AI prompting in the browser?

**Yes, using Effect AI!** This is a great approach for the BA chat interface.

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Browser                                   │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Chat UI Component                                     │  │
│  │  - Send messages                                       │  │
│  │  - Stream responses                                    │  │
│  │  - Preview generated features                          │  │
│  └───────────────────────────────────────────────────────┘  │
│                          │ HTTP/SSE                          │
└──────────────────────────┼───────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                  Nuxt Server                                 │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Effect AI Service                                     │  │
│  │  - Manages LLM connections                             │  │
│  │  - Handles tool calls                                  │  │
│  │  - Creates feature files                               │  │
│  └───────────────────────────────────────────────────────┘  │
│                          │                                   │
│                          ▼                                   │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  LLM Provider (Anthropic/OpenAI/etc)                   │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### Why Effect AI?

[Effect AI](https://effect.website/blog/effect-ai/) provides:

1. **Provider Agnostic**: Same code works with Anthropic, OpenAI, Ollama, etc.
2. **Type-Safe**: Full TypeScript support with Effect
3. **Tool Use**: Define tools as Effect services
4. **Streaming**: Native streaming support
5. **Error Handling**: Effect's composable error handling

### Implementation Sketch

```typescript
// server/services/ai.ts
import { AiChat, AiToolkit, Anthropic } from "@effect/ai"
import { Effect, Layer, Stream } from "effect"

// Define tools for the BA agent
const baTools = AiToolkit.make(
  AiToolkit.Tool(
    "createFeature",
    "Create a new feature in the backlog",
    {
      success: Schema.Struct({ featureId: Schema.String }),
      failure: Schema.String,
      payload: Schema.Struct({
        title: Schema.String,
        description: Schema.String,
        acceptanceCriteria: Schema.Array(Schema.String),
        tags: Schema.Array(Schema.String),
      }),
    },
    (payload) => Effect.gen(function* () {
      const storage = yield* StorageService
      const feature = yield* storage.createFeature(payload)
      return { featureId: feature.id }
    })
  )
)

// BA chat service
export const businessAnalystChat = (
  message: string,
  history: Message[]
): Stream.Stream<string, AiError> =>
  Effect.gen(function* () {
    const ai = yield* AiChat
    return ai.stream({
      system: BA_SYSTEM_PROMPT,
      messages: [...history, { role: "user", content: message }],
      tools: baTools,
    })
  }).pipe(Stream.unwrap)
```

### API Route (SSE Streaming)

```typescript
// server/api/chat.post.ts
export default defineEventHandler(async (event) => {
  const { message, history } = await readBody(event)

  setHeader(event, "Content-Type", "text/event-stream")
  setHeader(event, "Cache-Control", "no-cache")
  setHeader(event, "Connection", "keep-alive")

  const stream = businessAnalystChat(message, history).pipe(
    Effect.provide(AiLive),
    Stream.runForEach((chunk) =>
      Effect.sync(() => {
        event.node.res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`)
      })
    )
  )

  await Effect.runPromise(stream)
  event.node.res.end()
})
```

### Client Composable

```typescript
// composables/useChat.ts
export const useChat = () => {
  const messages = ref<Message[]>([])
  const isStreaming = ref(false)

  const send = async (content: string) => {
    isStreaming.value = true
    messages.value.push({ role: "user", content })

    const response = await fetch("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        message: content,
        history: messages.value,
      }),
    })

    const reader = response.body?.getReader()
    const decoder = new TextDecoder()
    let assistantMessage = ""

    while (true) {
      const { done, value } = await reader!.read()
      if (done) break

      const text = decoder.decode(value)
      const lines = text.split("\n")

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = JSON.parse(line.slice(6))
          assistantMessage += data.text
        }
      }
    }

    messages.value.push({ role: "assistant", content: assistantMessage })
    isStreaming.value = false
  }

  return { messages, isStreaming, send }
}
```

---

## Environment Variables

Create a `.env.local` file (not committed to git):

```bash
# AI Provider (choose one)
ANTHROPIC_API_KEY=sk-ant-...
# or
OPENAI_API_KEY=sk-...

# MCP
CONTEXT7_API_KEY=your-context7-key

# Optional: Custom model selection
AI_MODEL=claude-3-5-sonnet-20241022
```

---

## Recommended IDE Setup

### VS Code Extensions
- Vue - Official (Volar)
- TypeScript Vue Plugin (Volar)
- ESLint
- Tailwind CSS IntelliSense
- Effect (if available)

### Settings
```json
{
  "typescript.tsdk": "node_modules/typescript/lib",
  "editor.formatOnSave": true,
  "editor.codeActionsOnSave": {
    "source.fixAll.eslint": true
  }
}
```
