# Relay Architecture

## Core model

Relay uses a strict single-speaker architecture for Telegram topics.

### Roles

#### `@RiGHT_AI_BoT`
External transport / visible bot.

Responsibilities:
- receive Telegram messages
- preserve topic/thread context
- enqueue inbound messages
- send final replies back to Telegram

`@RiGHT_AI_BoT` is the only bot that should be visible to users in Telegram topics.

#### `session-driver`
Orchestrator / dispatcher.

Responsibilities:
- map each Telegram topic to exactly one session
- read queue files
- ignore internal/system traffic
- forward real user messages to the model runtime
- clean model output
- send final replies through the Telegram transport path

#### `@Cody_Code_bot`
Internal execution engine / Claude Code worker.

Responsibilities:
- reason
- use tools
- inspect and edit code
- produce a final user-facing answer

`@Cody_Code_bot` should not talk directly to Telegram.

## Required policy

### 1. Single active bot per topic
For every Telegram topic:
- one visible bot only: `@RiGHT_AI_BoT`
- one execution session only
- one outbound send path only

### 2. One topic = one session
Every topic maps to a single session.

Examples:
- topic `183` -> `relay`
- topic `201` -> `voice`
- topic `185` -> `itops-dev`

### 3. Claude/Cody returns text only
The execution layer must return only the final response text.

It must not emit:
- Telegram actions
- tool chatter
- startup chatter
- progress spinners
- checkpoint text
- internal logs

### 4. Telegram I/O stays outside the model
Telegram send/fetch/reply behavior belongs to the relay transport / driver path, not to the model session itself.

### 5. Ignore internal queue traffic
System/validator/force messages must not be treated as user work.

## Hardening implemented

The current relay hardening enforces the model above:

- `SESSION_DRIVER=oauth` rollout for relevant Claude sessions
- `startup ask()` disabled
- internal `system:*` / forced queue traffic ignored
- Telegram MCP disabled for runtime sessions
- Token Optimizer disabled
- cleaner hardened to strip tool/progress/TUI noise

## Practical flow

1. User writes in a Telegram topic
2. `@RiGHT_AI_BoT` receives the message
3. Relay writes it to the topic queue
4. `session-driver` picks it up
5. `session-driver` forwards it to Claude Code / Cody
6. Cody returns a clean final answer
7. `session-driver` sends that answer back through the Telegram transport path
8. User sees a single clean reply in the same topic

## Anti-patterns to avoid

Do not allow:
- two bots replying in the same topic
- direct Telegram tools inside Claude/Cody runtime
- startup/system messages entering the real work queue
- optimizer/checkpoint reports being posted to user chats
- multiple sessions competing for the same topic

## Short version

- `@RiGHT_AI_BoT` talks to Telegram
- `session-driver` orchestrates
- `@Cody_Code_bot` does the work
