# Viral Post — Twitter/X Thread + LinkedIn

---

## Twitter/X Thread

---

**Tweet 1 (hook)**

I built a way to control Claude Code from Telegram — while nowhere near my computer.

Send a message from my phone. Claude thinks. Replies with formatted code, test results, file diffs.

All inside the actual project. No SSH. No terminal.

Here's how it works 🧵

---

**Tweet 2 (the problem)**

The normal remote dev workflow is painful:

→ SSH into server
→ Attach to tmux
→ Wait for Claude to finish something
→ Lose connection mid-task
→ SSH again
→ Repeat

I wanted to manage projects the same way I manage everything else: from my phone, async, in chat.

---

**Tweet 3 (the solution)**

Each project gets its own Telegram topic (forum thread).

Claude Code runs in that project's directory with an MCP server connected to that topic.

You send a message → Claude gets it as an event → Claude calls tools, edits files, runs commands → Claude replies.

---

**Tweet 4 (the demo)**

Real example:

Me (from phone): "the API is returning 500s on /checkout — can you check the logs and find the cause?"

Claude:
• calls `typing` (I see the indicator immediately)
• runs `tail -200 /var/log/app.log`
• finds the issue (missing env var in prod)
• sends me a formatted summary with the fix

All while I'm away from my desk.

---

**Tweet 5 (the innovation)**

The tricky part: one Telegram bot token, multiple projects.

Telegram's API returns 409 Conflict if two processes both poll `getUpdates` with the same token.

Solution: a **routing bot** holds the single long-poll and writes messages to per-project queue files:

`/tmp/tg-queue-{THREAD_ID}.jsonl`

Each MCP server tails its own file. Zero conflicts.

---

**Tweet 6 (the architecture)**

```
Phone
  ↓
Telegram topic (one per project)
  ↓
Routing bot (single getUpdates)
  ↓
Queue file (/tmp/tg-queue-42.jsonl)
  ↓
MCP server (tails queue)
  ↓
Claude Code (in project directory)
  ↓
send_message tool
  ↓
Telegram topic
  ↓
Phone
```

Clean. No polling conflicts. Full context per project.

---

**Tweet 7 (what Claude can do)**

From Telegram, Claude can:

• Read and edit any file in the project
• Run shell commands and return output
• Check git status, diffs, logs
• Deploy, test, debug
• Answer questions with full codebase context

It's not a chatbot. It's Claude Code with full tool access, reachable from your phone.

---

**Tweet 8 (setup)**

Setup is ~15 minutes:

1. Create a Telegram bot (BotFather)
2. Enable Topics in your Supergroup
3. Add `.mcp.json` to your project pointing at this MCP server
4. Run the routing bot in tmux
5. `claude` in your project directory

One topic per project. One bot for everything.

---

**Tweet 9 (the bun gotcha)**

One hard-won tip:

`bun` must be in your **system PATH**, not just `~/.bun/bin`.

Claude Code spawns MCP servers with a minimal environment. If bun isn't at `/usr/local/bin/bun`, the server silently fails.

Fix:
```
sudo ln -sf ~/.bun/bin/bun /usr/local/bin/bun
```

Would have saved me an hour.

---

**Tweet 10 (CTA)**

Open source, MIT licensed.

→ github.com/shaike1/tmux-telegram

If you manage remote servers, run long Claude sessions, or just want to stop SSHing in to check on things — this is for you.

RT if you'd use this. Happy to answer questions 👇

---

---

## LinkedIn Version

---

**I built a way to control Claude Code from Telegram — no SSH required.**

Here's the problem I kept running into: I'd start a long Claude Code session on a remote server, step away, and then have no way to check in or redirect it without SSHing back in, re-attaching to tmux, and hunting for where things left off.

So I built a small MCP server that connects Claude Code to a Telegram topic.

**How it works:**

Each project gets its own Telegram topic (forum thread). Claude Code runs in that project's directory with the MCP server listening on that topic. When you send a message, Claude receives it as an event, processes it with full access to the project's files and tools, and replies — formatted, concise, in Telegram.

The interesting engineering challenge: Telegram returns a 409 Conflict error if two processes poll `getUpdates` with the same bot token. When you have multiple projects sharing one bot, you can't have each MCP server poll directly.

The solution is a routing bot that holds the single long-poll and writes incoming messages to per-project queue files (`/tmp/tg-queue-{THREAD_ID}.jsonl`). Each MCP server tails its own file. No conflicts, no duplicated API calls.

**What this enables:**

- Ask Claude to check logs, debug errors, or summarize recent changes — from your phone
- Redirect a running session without touching a terminal
- Manage multiple projects from one Telegram group, each in its own topic
- Full Claude Code capabilities: file editing, shell commands, git, deploys

**It's open source (MIT):** github.com/shaike1/tmux-telegram

Built with Bun, the MCP SDK, and a healthy frustration with SSH. Happy to discuss the architecture in the comments.

#ClaudeCode #MCP #DeveloperTools #Telegram #RemoteDev #OpenSource

---
