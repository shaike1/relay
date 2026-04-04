FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV TERM=xterm-256color

# s6-overlay for process supervision
ARG S6_OVERLAY_VERSION=3.2.0.2
ADD https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz /tmp/s6-noarch.tar.xz

# System deps + extract s6-overlay (arch-aware)
RUN apt-get update && apt-get install -y \
    python3 python3-pip \
    curl wget git unzip \
    tmux openssh-client \
    jq ca-certificates \
    xz-utils \
    docker.io \
    && rm -rf /var/lib/apt/lists/* \
    && ARCH=$(uname -m) \
    && case "$ARCH" in \
         x86_64)  S6_ARCH=x86_64 ;; \
         aarch64) S6_ARCH=aarch64 ;; \
         armv7l)  S6_ARCH=arm ;; \
         *)       S6_ARCH=x86_64 ;; \
       esac \
    && wget -q "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-${S6_ARCH}.tar.xz" -O /tmp/s6-arch.tar.xz \
    && tar -C / -Jxpf /tmp/s6-noarch.tar.xz \
    && tar -C / -Jxpf /tmp/s6-arch.tar.xz \
    && rm /tmp/s6-noarch.tar.xz /tmp/s6-arch.tar.xz

# GitHub CLI + Copilot CLI (for copilot session type)
RUN mkdir -p -m 755 /etc/apt/keyrings \
    && wget -nv -O /tmp/gh-keyring.gpg https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    && cp /tmp/gh-keyring.gpg /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/* /tmp/gh-keyring.gpg

# Pre-install Copilot CLI binary so gh copilot doesn't prompt interactively
RUN ARCH=$(uname -m) \
    && case "$ARCH" in \
         x86_64)  COPILOT_ARCH=x64 ;; \
         aarch64) COPILOT_ARCH=arm64 ;; \
         *)       COPILOT_ARCH=x64 ;; \
       esac \
    && mkdir -p /root/.local/share/gh \
    && wget -nv -O /tmp/copilot.tar.gz \
       "https://github.com/github/copilot-cli/releases/latest/download/copilot-linux-${COPILOT_ARCH}.tar.gz" \
    && tar xzf /tmp/copilot.tar.gz -C /root/.local/share/gh/ \
    && chmod +x /root/.local/share/gh/copilot \
    && cp /root/.local/share/gh/copilot /usr/local/bin/copilot \
    && rm -f /tmp/copilot.tar.gz

# Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"
RUN ln -sf /root/.bun/bin/bun /usr/local/bin/bun

# Node.js + Claude Code
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code

# oauth-cli-coder for programmatic session management
RUN pip install --break-system-packages oauth-cli-coder

WORKDIR /relay

# Symlink /root/relay → /relay so .mcp.json paths (written by bot with host paths) work in container
RUN mkdir -p /root && ln -sf /relay /root/relay

# MCP server deps
COPY mcp-telegram/package.json mcp-telegram/bun.lock* ./mcp-telegram/
RUN cd mcp-telegram && bun install --frozen-lockfile --silent

# Relay source
COPY . .

# s6-rc service definitions for session container (session-specific layout)
COPY s6-overlay-session/s6-rc.d /etc/s6-overlay/s6-rc.d
RUN chmod +x /etc/s6-overlay/s6-rc.d/claude-session/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/message-watchdog/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/claude-update/up \
    && chmod +x /etc/s6-overlay/s6-rc.d/codex-bot/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/session-driver/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/token-monitor/run \
    && chmod +x /relay/scripts/claude-session-loop.sh \
    && chmod +x /relay/scripts/copilot-session-loop.sh \
    && chmod +x /relay/scripts/mcp-server-wrapper.sh \
    && chmod +x /relay/scripts/message-watchdog.sh \
    && chmod +x /relay/scripts/tg-send.sh \
    && chmod +x /relay/scripts/session-driver.py \
    && ln -sf /relay/scripts/tg-send.sh /usr/local/bin/tg-send

# s6-overlay is the init
ENTRYPOINT ["/init"]
