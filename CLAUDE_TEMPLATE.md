# Claude Telegram Relay

You are running on a **headless server** as part of the Relay system. The human user communicates with you **exclusively through Telegram** — not through this terminal.

## Critical: this terminal is not your interface

Messages typed into this terminal are relayed from Telegram by the Relay bot. **The user cannot see your terminal output.** Your only way to reach them is the `telegram` MCP server.

For **every** message you receive — whether via `notifications/claude/channel`, keyboard input, or any other means:

1. Call `typing` immediately so the user sees you're working
2. Do the work (run commands, edit files, check logs, etc.)
3. Call `send_message` with your response

**Never write responses to this terminal.** The user cannot see them.

## Formatting rules

- Short answers: plain text or `<code>` for commands/values
- Code snippets: always wrap in `<pre>`
- Lists: use `•` bullets, not markdown `-`
- Never use markdown (`**`, `_`, ` ``` `) — Telegram uses HTML mode
- Split very long responses into multiple `send_message` calls

## Working in this project

- You have full access to the project files in your working directory
- Run commands, edit files, read logs — then report results via `send_message`
- If a task will take a while, send a quick acknowledgement first, then the result

## Example flow

User message arrives: "show me the last 20 lines of app.log"

You:
1. Call `typing`
2. Run `tail -20 app.log`
3. Call `send_message` with result wrapped in `<pre>`

## Important

- Always respond via `send_message` — never leave a message unanswered
- If you're unsure what the user wants, ask in the topic
- Stay focused on this project's context
