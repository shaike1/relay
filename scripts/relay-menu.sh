#!/bin/bash
# relay-menu.sh — interactive session picker for nomacode/web terminals.
# No tmux hub required — directly execs into each container's tmux session.

REMOTE_HOST="${RELAY_REMOTE_HOST:-root@100.64.0.12}"

while true; do
    clear
    echo "╔══════════════════════════════════════╗"
    echo "║         RELAY SESSION HUB            ║"
    echo "╚══════════════════════════════════════╝"
    echo ""

    # Build session list
    declare -a names
    declare -a hosts
    i=1

    echo "  LOCAL ($(hostname -I | awk '{print $1}' 2>/dev/null || echo 'local')):"
    while IFS= read -r s; do
        [ -z "$s" ] && continue
        status=$(docker inspect --format='{{.State.Status}}' "relay-session-$s" 2>/dev/null || echo "?")
        printf "  %2d) %-20s [%s]\n" "$i" "$s" "$status"
        names[$i]="$s"
        hosts[$i]="local"
        ((i++))
    done < <(docker ps --format '{{.Names}}' 2>/dev/null | grep '^relay-session-' | sed 's/relay-session-//' | sort)

    echo ""
    echo "  REMOTE ($REMOTE_HOST):"
    while IFS= read -r s; do
        [ -z "$s" ] && continue
        printf "  %2d) %-20s [remote]\n" "$i" "$s"
        names[$i]="$s"
        hosts[$i]="remote"
        ((i++))
    done < <(ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o BatchMode=yes "$REMOTE_HOST" \
        "docker ps --format '{{.Names}}' 2>/dev/null | grep '^relay-session-' | sed 's/relay-session-//'" 2>/dev/null | sort)

    echo ""
    echo "  q) Quit"
    echo ""
    read -rp "Select session: " choice

    [ "$choice" = "q" ] && exit 0
    [ -z "$choice" ] && continue

    # Validate
    session="${names[$choice]:-}"
    host="${hosts[$choice]:-}"
    if [ -z "$session" ]; then
        echo "Invalid choice."
        sleep 1
        continue
    fi

    container="relay-session-$session"
    echo ""
    echo "Connecting to $session..."

    if [ "$host" = "local" ]; then
        docker exec -it "$container" \
            tmux -S "/tmp/tmux-${session}.sock" attach -t "$session" 2>/dev/null \
            || (echo "Session not ready — starting bash..."; docker exec -it "$container" bash)
    else
        ssh -t -o StrictHostKeyChecking=no "$REMOTE_HOST" \
            "docker exec -it $container tmux -S /tmp/tmux-${session}.sock attach -t $session 2>/dev/null || (echo 'Session not ready — starting bash...'; docker exec -it $container bash)"
    fi

    echo ""
    echo "Disconnected from $session. Press Enter to return to menu..."
    read -r
done
