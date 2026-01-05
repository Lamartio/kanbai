# AGENTS.md - AI Agents Architecture

This document describes the AI agents system in Kanbai and how they interact with the human project manager.

## Overview

Kanbai uses a multi-agent architecture where:
- **Human**: Acts as the Project Manager, making decisions and approving work
- **Business Analyst AI**: Helps define features through conversation
- **Developer AI Agents**: Implement approved features

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Human (Project Manager)                      │
│                                                                      │
│  Responsibilities:                                                   │
│  • Review and approve feature definitions                            │
│  • Move features through Kanban stages                               │
│  • Review and approve implementations                                │
│  • Prioritize backlog                                                │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    ▼                               ▼
┌─────────────────────────────┐   ┌─────────────────────────────┐
│    Business Analyst AI       │   │    Developer AI Agents       │
│                              │   │                              │
│  Responsibilities:           │   │  Responsibilities:           │
│  • Elicit requirements       │   │  • Implement features        │
│  • Define acceptance criteria│   │  • Write tests               │
│  • Create feature documents  │   │  • Submit for review         │
│  • Clarify scope            │   │  • Address feedback          │
└─────────────────────────────┘   └─────────────────────────────┘
```

## Agent Roles

### Business Analyst AI

The BA agent helps translate ideas into structured feature specifications through conversation.

**Capabilities:**
- Natural language conversation to understand requirements
- Breaking down large ideas into discrete features
- Generating acceptance criteria
- Suggesting appropriate tags and priorities
- Creating feature markdown documents

**Conversation Flow:**
```
User: "I want users to be able to log in"
  ↓
BA: "Let me understand the requirements. What authentication
     methods should be supported? Email/password? OAuth? SSO?"
  ↓
User: "Email/password for now, OAuth later"
  ↓
BA: "Got it. Should we include:
     - Password reset functionality?
     - Remember me option?
     - Account lockout after failed attempts?"
  ↓
User: "Yes to all"
  ↓
BA: "I'll create a feature specification. Here's the draft:
     [Shows preview of feature document]
     Should I save this as TODO?"
```

**Output Format:**
The BA creates feature files with complete specifications:

```markdown
---
id: AUTH-001
title: User Authentication - Email/Password
tags:
  - TODO
  - auth
  - security
  - priority-high
created: 2024-01-05T10:00:00Z
---

# User Authentication - Email/Password

## Description
Implement user authentication allowing users to register and log in
with email and password credentials.

## Acceptance Criteria
- [ ] User can register with email and password
- [ ] User can log in with valid credentials
- [ ] User receives error message for invalid credentials
- [ ] User can request password reset via email
- [ ] User can check "Remember me" to stay logged in
- [ ] Account locks after 5 failed login attempts

## Out of Scope
- OAuth/SSO (separate feature: AUTH-002)
- Two-factor authentication (future consideration)

## Conversation Log
> **User**: I want users to be able to log in
> **BA**: What authentication methods should be supported?
> ...
```

### Developer AI Agents

Developer agents implement features defined by the BA. Multiple developer agents can work on different features in parallel.

**Capabilities:**
- Reading and understanding feature specifications
- Implementing code changes
- Writing tests
- Submitting work for review
- Addressing review feedback

**Workflow:**
```
1. Feature assigned (moved to DOING)
   ↓
2. Developer reads feature spec
   ↓
3. Developer implements feature
   ↓
4. Developer runs tests
   ↓
5. Developer submits for review (moved to REVIEWING)
   ↓
6. Human reviews
   ↓
7. If approved → DONE
   If changes needed → Back to DOING with feedback
```

**Status Updates:**
Developers update the feature file with progress:

```markdown
## Implementation Notes

### Progress
- [x] Created User model
- [x] Implemented registration endpoint
- [x] Implemented login endpoint
- [ ] Password reset flow
- [ ] Remember me functionality

### Technical Decisions
- Using bcrypt for password hashing
- JWT tokens with 7-day expiry for "remember me"
- Rate limiting: 5 requests per minute per IP
```

## Effect AI Integration

Kanbai uses [Effect AI](https://effect.website/blog/effect-ai/) for AI agent integration, providing:

- **Unified API**: Same interface for different LLM providers
- **Structured Output**: Type-safe responses via `@effect/schema`
- **Tool Use**: Agents can call tools defined as Effects
- **Streaming**: Real-time response streaming for conversations

### Agent Service Architecture

```typescript
// Agent service definition
class AgentService extends Context.Tag("AgentService")<
  AgentService,
  {
    readonly businessAnalyst: {
      readonly chat: (message: string, context: ConversationContext)
        => Stream.Stream<ChatChunk, AgentError>
      readonly generateFeature: (context: ConversationContext)
        => Effect.Effect<FeatureDocument, AgentError>
    }
    readonly developer: {
      readonly analyzeFeature: (featureId: string)
        => Effect.Effect<ImplementationPlan, AgentError>
      readonly implement: (featureId: string, plan: ImplementationPlan)
        => Effect.Effect<ImplementationResult, AgentError>
    }
  }
>() {}
```

### Tools Available to Agents

**Business Analyst Tools:**
- `createFeature` - Create a new feature file
- `updateFeature` - Update feature content
- `searchFeatures` - Search existing features
- `suggestTags` - Get tag suggestions

**Developer Tools:**
- `readFile` - Read project files
- `writeFile` - Write/update files
- `runTests` - Execute test suite
- `runLint` - Run linting
- `submitForReview` - Move feature to REVIEWING

## Browser-Based AI Prompting

The UI supports in-browser AI conversations using Effect AI, enabling:

1. **Real-time Conversations**: Stream responses to the browser
2. **Feature Creation**: Create features directly from chat
3. **Markdown Preview**: See feature documents as they're generated

### Implementation Approach

```typescript
// Server endpoint for streaming chat
export default defineEventHandler(async (event) => {
  const { message, conversationId } = await readBody(event)

  const stream = AgentService.pipe(
    Effect.flatMap(agent => agent.businessAnalyst.chat(message, context)),
    Stream.runCollect,
    Effect.provide(AgentServiceLive)
  )

  // Return as SSE stream
  setResponseHeader(event, 'Content-Type', 'text/event-stream')
  // Stream implementation...
})
```

### Client Integration

```typescript
// Composable for AI chat
export const useBAChat = () => {
  const messages = ref<Message[]>([])
  const isStreaming = ref(false)

  const sendMessage = async (content: string) => {
    isStreaming.value = true
    messages.value.push({ role: 'user', content })

    const response = await $fetch('/api/chat', {
      method: 'POST',
      body: { message: content, conversationId },
      responseType: 'stream'
    })

    // Handle streaming response...
  }

  return { messages, isStreaming, sendMessage }
}
```

## Future Considerations

### Agent Orchestration
- Multiple developer agents working in parallel
- Agent specialization (frontend, backend, testing)
- Automatic task assignment based on availability

### Quality Assurance
- Code review agent
- Security audit agent
- Performance testing agent

### Learning & Improvement
- Agent feedback loops
- Pattern recognition from completed features
- Estimation improvement based on historical data
