#!/bin/bash
# hub.sh — interactive session picker for relay containers (local + remote).
# Works in both SSH terminals and web terminals (nomacode).
#
# Usage:
#   ./scripts/hub.sh            # show session menu
#   ./scripts/hub.sh --list     # just list available sessions

export LANG=C.UTF-8
export LC_ALL=C.UTF-8
export TERM="${TERM:-xterm-256color}"

# When used as ForceCommand in sshd_config, SSH sets SSH_ORIGINAL_COMMAND.
# Pass it through so non-interactive SSH (scp, rsync, commands) works correctly.
if [[ -n "${SSH_ORIGINAL_COMMAND:-}" ]]; then
    exec /bin/bash -c "$SSH_ORIGINAL_COMMAND"
fi

# When used as a login shell, SSH calls: hub.sh -c "command"
if [[ "${1:-}" == "-c" ]]; then
    exec /bin/bash -c "${2:-}"
fi

# Explicit non-interactive modes must run before the no-TTY fallback.
if [[ "${1:-}" == "--list" ]]; then
    REMOTE_HOST="${RELAY_REMOTE_HOST:-root@100.64.0.12}"

    list_local() {
        docker ps --format '{{.Names}}' 2>/dev/null | grep '^relay-session-' | sed 's/relay-session-//' | sort
    }

    list_remote() {
        ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no "$REMOTE_HOST" \
            "docker ps --format '{{.Names}}' 2>/dev/null | grep '^relay-session-' | sed 's/relay-session-//'" 2>/dev/null | sort
    }

    echo "=== Local sessions ==="
    list_local
    echo "=== Remote sessions ($REMOTE_HOST) ==="
    list_remote
    exit 0
fi

# If no TTY available (e.g. non-interactive SSH, SCP, port forwarding),
# fall back to plain bash shell. Only pass args that bash understands (not --list etc).
if [[ ! -t 0 && ! -t 1 ]]; then
    exec /bin/bash
fi

REMOTE_HOST="${RELAY_REMOTE_HOST:-root@100.64.0.12}"

list_local() {
    docker ps --format '{{.Names}}' 2>/dev/null | grep '^relay-session-' | sed 's/relay-session-//' | sort
}

list_remote() {
    ssh -o ConnectTimeout=3 -o StrictHostKeyChecking=no "$REMOTE_HOST" \
        "docker ps --format '{{.Names}}' 2>/dev/null | grep '^relay-session-' | sed 's/relay-session-//'" 2>/dev/null | sort
}

# Set initial terminal title
printf '\033]0;relay-hub\007'

# Interactive menu
while true; do
    echo "---"
    echo "╔══════════════════════════════════════════╗"
    echo "║           RELAY SESSION HUB              ║"
    echo "╚══════════════════════════════════════════╝"
    echo ""

    names=()
    hosts=()
    i=1

    # Fetch local and remote lists in parallel
    local_tmp=$(mktemp)
    remote_tmp=$(mktemp)
    list_local > "$local_tmp" &
    list_remote > "$remote_tmp" &
    wait

    echo "  LOCAL:"
    while IFS= read -r s; do
        [ -z "$s" ] && continue
        printf "  %2d) %-22s\n" "$i" "$s"
        names[$i]="$s"
        hosts[$i]="local"
        ((i++))
    done < "$local_tmp"

    echo ""
    echo "  REMOTE ($REMOTE_HOST):"
    while IFS= read -r s; do
        [ -z "$s" ] && continue
        printf "  %2d) %-22s [remote]\n" "$i" "$s"
        names[$i]="$s"
        hosts[$i]="remote"
        ((i++))
    done < "$remote_tmp"
    rm -f "$local_tmp" "$remote_tmp"

    total=$((i - 1))
    echo ""
    echo "  r) Refresh    q) Quit to shell    x) Exit"
    echo ""
    read -rp "Select session [1-${total}]: " choice

    [[ "$choice" == "x" ]] && exit 0
    if [[ "$choice" == "q" ]]; then
        exec env RELAY_HUB_BYPASS=1 /bin/bash --login
    fi
    [[ "$choice" == "r" ]] && continue
    [[ -z "$choice" ]] && continue

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

    # Set terminal title to session name
    printf '\033]0;%s\007' "$session"

    if [ "$host" = "local" ]; then
        # Detach stale clients and attach in a single docker exec to reduce round-trips
        docker exec -it "$container" \
            sh -c "tmux -S /tmp/tmux-${session}.sock list-clients -F '#{client_tty}' 2>/dev/null | while read tty; do tmux -S /tmp/tmux-${session}.sock detach-client -t \"\$tty\" 2>/dev/null; done; tmux -S /tmp/tmux-${session}.sock attach -d -t ${session} 2>/dev/null || bash" \
            2>/dev/null \
            || docker exec -it "$container" bash
    else
        ssh -t -o StrictHostKeyChecking=no "$REMOTE_HOST" \
            "docker exec -it $container tmux -S /tmp/tmux-${session}.sock attach -t $session 2>/dev/null || docker exec -it $container bash"
    fi

    # Reset terminal title back to hub when returning
    printf '\033]0;relay-hub\007'

    echo ""
    echo "Disconnected from $session. Press Enter to return to menu..."
    read -r
done
