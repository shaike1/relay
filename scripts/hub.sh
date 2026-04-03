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

REMOTE_HOST="${RELAY_REMOTE_HOST:-root@100.64.0.12}"
ATTACH_RETRIES="${RELAY_HUB_ATTACH_RETRIES:-5}"
ATTACH_RETRY_DELAY="${RELAY_HUB_ATTACH_RETRY_DELAY:-1}"
COMMAND_TIMEOUT="${RELAY_HUB_COMMAND_TIMEOUT:-10}"
SSH_OPTS=(-o ConnectTimeout=3 -o ServerAliveInterval=5 -o ServerAliveCountMax=1 -o StrictHostKeyChecking=no -o LogLevel=ERROR)
SSH_BATCH_OPTS=("${SSH_OPTS[@]}" -o BatchMode=yes)

run_local_control() {
    timeout "$COMMAND_TIMEOUT" "$@"
}

run_remote_control() {
    timeout "$COMMAND_TIMEOUT" ssh "${SSH_BATCH_OPTS[@]}" "$REMOTE_HOST" "$1"
}

list_local() {
    run_local_control docker ps --format '{{.Names}}' 2>/dev/null | grep '^relay-session-' | sed 's/relay-session-//' | sort
}

list_remote() {
    run_remote_control "docker ps --format '{{.Names}}' 2>/dev/null | grep '^relay-session-' | sed 's/relay-session-//'" 2>/dev/null | sort
}

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

container_running_local() {
    run_local_control docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null | grep -qx true
}

tmux_session_exists_local() {
    local container="$1"
    local socket="$2"
    local session="$3"
    run_local_control docker exec "$container" sh -lc "tmux -S '$socket' has-session -t '$session'" >/dev/null 2>&1
}

detach_stale_clients_local() {
    local container="$1"
    local socket="$2"
    local session="$3"
    run_local_control docker exec "$container" \
        sh -lc "tmux -S '$socket' list-clients -t '$session' -F '#{client_tty}' 2>/dev/null | while IFS= read -r tty; do [ -n \"\$tty\" ] || continue; tmux -S '$socket' detach-client -t \"\$tty\" 2>/dev/null || true; done" \
        >/dev/null 2>&1 || true
}

attach_local() {
    local container="$1"
    local session="$2"
    local socket="/tmp/tmux-${session}.sock"
    local attempt rc

    for ((attempt = 1; attempt <= ATTACH_RETRIES; attempt++)); do
        if ! container_running_local "$container"; then
            echo "Container $container is not running."
            return 1
        fi

        detach_stale_clients_local "$container" "$socket" "$session"

        if tmux_session_exists_local "$container" "$socket" "$session"; then
            docker exec -it "$container" \
                sh -lc "exec tmux -S '$socket' attach -d -t '$session' || exec bash"
            rc=$?
            [ "$rc" -eq 0 ] && return 0
        elif [ "$attempt" -eq "$ATTACH_RETRIES" ]; then
            echo "tmux session '$session' is not ready in $container. Opening shell instead."
            docker exec -it "$container" bash
            return $?
        fi

        if [ "$attempt" -lt "$ATTACH_RETRIES" ]; then
            echo "Waiting for $session to become attachable ($attempt/$ATTACH_RETRIES)..."
            sleep "$ATTACH_RETRY_DELAY"
        fi
    done

    echo "Attach to $session failed after $ATTACH_RETRIES attempts. Opening shell instead."
    docker exec -it "$container" bash
}

attach_remote() {
    local container="$1"
    local session="$2"
    local socket="/tmp/tmux-${session}.sock"
    local attempt

    for ((attempt = 1; attempt <= ATTACH_RETRIES; attempt++)); do
        if ! run_remote_control "docker inspect -f '{{.State.Running}}' '$container' 2>/dev/null | grep -qx true"; then
            echo "Remote container $container is not running on $REMOTE_HOST."
            return 1
        fi

        run_remote_control \
            "docker exec '$container' sh -lc \"tmux -S '$socket' list-clients -t '$session' -F '#{client_tty}' 2>/dev/null | while IFS= read -r tty; do [ -n \\\$tty ] || continue; tmux -S '$socket' detach-client -t \\\$tty 2>/dev/null || true; done\"" \
            >/dev/null 2>&1 || true

        if run_remote_control "docker exec '$container' sh -lc \"tmux -S '$socket' has-session -t '$session'\"" >/dev/null 2>&1; then
            ssh -t "${SSH_OPTS[@]}" "$REMOTE_HOST" \
                "docker exec -it '$container' sh -lc \"exec tmux -S '$socket' attach -d -t '$session' || exec bash\""
            return $?
        fi

        if [ "$attempt" -lt "$ATTACH_RETRIES" ]; then
            echo "Waiting for remote $session to become attachable ($attempt/$ATTACH_RETRIES)..."
            sleep "$ATTACH_RETRY_DELAY"
        fi
    done

    echo "Remote tmux session '$session' is not ready on $REMOTE_HOST. Opening shell instead."
    ssh -t "${SSH_OPTS[@]}" "$REMOTE_HOST" "docker exec -it '$container' bash"
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
        attach_local "$container" "$session"
    else
        attach_remote "$container" "$session"
    fi

    # Reset terminal title back to hub when returning
    printf '\033]0;relay-hub\007'

    echo ""
    echo "Disconnected from $session. Press Enter to return to menu..."
    read -r
done
