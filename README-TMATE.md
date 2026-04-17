# Relay + tmate Live Debugging

## מה זה?
`tmate` מאפשר לשתף terminal session בזמן אמת דרך קישור.

## שימוש מהיר

### 1. הרץ session-driver עם tmate:
```bash
/root/relay/scripts/session-driver-debug.sh edushare /root/.openclaw/workspace/edushare 12
```

### 2. קבל קישור לשיתוף:
tmate יציג:
```
ssh session read only: ssh ro-XXX@nyc1.tmate.io
web session read only: https://tmate.io/t/ro-XXX
```

### 3. שתף את הקישור

## שימוש ידני

```bash
# להתחיל session
tmate

# לקבל קישורי שיתוף
tmate show-messages

# לצאת
Ctrl+B, D
```

## Tips
- Read-only: קישור `ro-XXX` = צפייה בלבד
- Full access: קישור רגיל = גם כתיבה
- Background: הרץ עם `nohup` או בתוך `tmux`

## Docker Compose Integration

### session עם tmate אוטומטית
`sessions.json` כבר מוגדר עבור edushare עם `TMATE_DEBUG=1`

### לקבל קישורים מcontainer רץ:
```bash
docker exec relay-session-edushare tmate show-messages
```

## Aliases מותקנים

```bash
relay-edushare-debug    # הרץ edushare עם tmate
relay-voice-debug       # הרץ voice עם tmate  
relay-links             # הצג קישורי שיתוף
relay-debug             # tmate session רגיל
```

השתמש ב-`source ~/.bashrc` או פתח terminal חדש להפעלת aliases.
