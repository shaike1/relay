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

→ github.com/shaike1/relay

If you manage remote servers, run long Claude sessions, or just want to stop SSHing in to check on things — this is for you.

RT if you'd use this. Happy to answer questions 👇

---

---

---

## גרסה בעברית — Twitter/X Thread

---

**ציוץ 1 (הוק)**

בניתי דרך לשלוט ב-Claude Code מטלגרם — בלי להיות ליד המחשב בכלל.

שולח הודעה מהטלפון. Claude חושב. מחזיר קוד מפורמט, תוצאות טסטים, דיפים.

הכל בתוך הפרויקט האמיתי. בלי SSH. בלי טרמינל.

אז איך זה עובד? 🧵

---

**ציוץ 2 (הבעיה)**

ניהול סשנים מרוחקים זה כאב ראש אחד גדול:

→ SSH לשרת
→ להתחבר ל-tmux
→ לחכות ש-Claude יגמור משהו
→ החיבור נופל באמצע
→ SSH שוב
→ לחפש איפה הפסקת
→ לחזור על זה שוב

רציתי לנהל פרויקטים כמו שאני מנהל הכל השאר — מהטלפון, אסינכרוני, בצ'אט.

---

**ציוץ 3 (הפתרון)**

כל פרויקט מקבל Topic משלו בטלגרם (thread ייחודי בקבוצה).

Claude Code רץ בתיקיית הפרויקט עם MCP server שמחובר לאותו Topic.

אתה שולח הודעה → Claude מקבל אותה כאירוע → Claude מריץ כלים, עורך קבצים, מריץ פקודות → Claude מחזיר תשובה.

זה הכל. אין SSH. אין טרמינל פתוח.

---

**ציוץ 4 (דמו אמיתי)**

דוגמה מהחיים:

אני (מהטלפון): "ה-API מחזיר 500 על /checkout — בדוק לוגים ומצא את הסיבה"

Claude:
• שולח `typing` (אני רואה את האינדיקטור מיד)
• מריץ `tail -200 /var/log/app.log`
• מוצא את הבעיה (משתנה env חסר בפרודקשן)
• שולח סיכום מפורמט עם הפתרון

כל זה בזמן שאני בחוץ, רחוק מהמחשב.

---

**ציוץ 5 (האתגר הטכני)**

הבעיה הכי מסובכת: טוקן בוט אחד, פרויקטים מרובים.

ה-API של טלגרם מחזיר 409 Conflict אם שני תהליכים מושכים `getUpdates` עם אותו טוקן בו-זמנית.

הפתרון: **Relay bot** אחד מחזיק את ה-long-poll ורושם הודעות לקבצי תור per-project:

`/tmp/tg-queue-{THREAD_ID}.jsonl`

כל MCP server קורא רק את הקובץ שלו. אפס קונפליקטים.

---

**ציוץ 6 (הארכיטקטורה)**

```
טלפון
  ↓
Telegram Topic (אחד לכל פרויקט)
  ↓
Relay Bot (getUpdates יחיד)
  ↓
Queue file (/tmp/tg-queue-42.jsonl)
  ↓
MCP Server (קורא את הקובץ שלו)
  ↓
Claude Code (בתיקיית הפרויקט)
  ↓
send_message
  ↓
Telegram Topic
  ↓
טלפון
```

נקי. אין קונפליקטים. הקשר מלא לכל פרויקט.

---

**ציוץ 7 (מה Claude יכול לעשות)**

מטלגרם, Claude יכול:

• לקרוא ולערוך כל קובץ בפרויקט
• להריץ פקודות shell ולהחזיר פלט
• לבדוק git status, diffs, לוגים
• לדפלוי, לטסט, לדבג
• לענות על שאלות עם הקשר מלא של הקוד

זה לא chatbot. זה Claude Code עם גישה מלאה לכלים — נגיש מהטלפון.

---

**ציוץ 8 (עמידות)**

וכאן מה שהופך את זה לאמיתי:

הסשנים רצים ב-tmux שמנוהל על ידי systemd.
כשהשרת מתאתחל — Relay חוזר לפעולה לבד.
כשהסשן נפתח מחדש — Claude ממשיך מאיפה שהפסיק (`claude --resume`).

חיבור ה-SSH שלך נפל? לא משנה.
הלפטופ נסגר? לא משנה.
השרת ריסטרט? Claude ממשיך לבד.

זו הדרך שניהול מרחוק אמור לעבוד.

---

**ציוץ 9 (התקנה)**

התקנה בפקודה אחת:

```
git clone https://github.com/shaike1/relay
cd relay && bash install.sh
```

הסקריפט מתקין הכל: תלויות Python, Bun, קרדנציאלים, שירות systemd.

אחר כך: `/new /path/to/project` בטלגרם — וזהו.

---

**ציוץ 10 (CTA)**

קוד פתוח, רישיון MIT.

→ github.com/shaike1/relay

אם אתם מנהלים שרתים מרוחקים, מריצים סשנים ארוכים של Claude, או פשוט רוצים להפסיק ל-SSH רק כדי לבדוק מה קורה — זה בשבילכם.

RT אם הייתם משתמשים בזה. שאלות? אשמח לענות 👇

---

---

## גרסה בעברית — LinkedIn

---

**בניתי את הדרך שניהול מרחוק היה אמור לעבוד מההתחלה.**

הבעיה שנתקלתי בה שוב ושוב: מתחיל סשן של Claude Code על שרת מרוחק, עוזב, ואין לי דרך לבדוק מה קורה או לתת הוראות חדשות בלי לחזור ל-SSH, לחפש את ה-tmux, ולהתמצא מחדש.

אז בניתי Relay — גשר בין Claude Code לטלגרם.

**איך זה עובד:**

כל פרויקט מקבל Topic ייחודי בטלגרם (thread בתוך קבוצה). Claude Code רץ בתיקיית הפרויקט עם MCP server שמקשיב לאותו Topic. כשאתה שולח הודעה, Claude מקבל אותה כאירוע, מעבד אותה עם גישה מלאה לקבצים ולכלים של הפרויקט, ומשיב — מפורמט, תמציתי, ישירות בטלגרם.

**האתגר הטכני המעניין:**

טלגרם מחזיר שגיאת 409 Conflict אם שני תהליכים מושכים `getUpdates` עם אותו טוקן בוט. כשיש כמה פרויקטים שחולקים בוט אחד, לא ניתן לתת לכל MCP server למשוך ישירות.

הפתרון: Relay bot שמחזיק את ה-long-poll היחיד ורושם כל הודעה לקובץ תור per-project בשם `/tmp/tg-queue-{THREAD_ID}.jsonl`. כל MCP server קורא רק את הקובץ שלו. אין קונפליקטים, אין קריאות API כפולות.

**מה זה מאפשר:**

- לשאול את Claude לבדוק לוגים, לדבג שגיאות, לסכם שינויים — מהטלפון
- לתת הוראות חדשות לסשן פעיל בלי לגעת בטרמינל
- לנהל מספר פרויקטים מקבוצת טלגרם אחת, כל אחד ב-Topic משלו
- יכולות Claude Code המלאות: עריכת קבצים, פקודות shell, git, דפלוי

**והדבר שהופך את זה מכלי לתשתית:**

הסשנים רצים ב-tmux תחת systemd. שרת ריסטרט? Relay חוזר לבד, Claude ממשיך מאיפה שהפסיק. חיבור SSH נפל? לא רלוונטי. הטלגרם תמיד פתוח בטלפון — וזה כל מה שצריך.

זו הדרך שניהול מרחוק היה אמור לעבוד.

**קוד פתוח (MIT):** github.com/shaike1/relay

#ClaudeCode #MCP #פיתוח #DevTools #Telegram #RemoteDev #OpenSource

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

**It's open source (MIT):** github.com/shaike1/relay

Built with Bun, the MCP SDK, and a healthy frustration with SSH. Happy to discuss the architecture in the comments.

#ClaudeCode #MCP #DeveloperTools #Telegram #RemoteDev #OpenSource

---
