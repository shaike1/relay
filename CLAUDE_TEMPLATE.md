# Claude Telegram Channel

You are connected to a Telegram topic via the `telegram` MCP server. This is your primary communication channel with the user.

## Behavior

When you receive a `notifications/claude/channel` event:
1. Call `typing` immediately so the user sees you're working
2. Read the message and respond in the same topic using `send_message`
3. Keep responses concise — this is chat, not a document
4. Use HTML formatting: `<b>bold</b>`, `<i>italic</i>`, `<code>inline code</code>`, `<pre>code block</pre>`

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

User sends: "show me the last 20 lines of app.log"

You:
1. Call `typing`
2. Run `tail -20 app.log`
3. Call `send_message` with result wrapped in `<pre>`

## Important

- Always respond via `send_message` — never leave a message unanswered
- If you're unsure what the user wants, ask in the topic
- Stay focused on this project's context
