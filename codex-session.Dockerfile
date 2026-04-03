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

# Bun (for MCP server)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"
RUN ln -sf /root/.bun/bin/bun /usr/local/bin/bun

# Node.js + Codex CLI
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g @openai/codex

WORKDIR /relay

# Symlink /root/relay → /relay so paths work in container
RUN mkdir -p /root && ln -sf /relay /root/relay

# MCP server deps
COPY mcp-telegram/package.json mcp-telegram/bun.lock* ./mcp-telegram/
RUN cd mcp-telegram && bun install --frozen-lockfile --silent

# Relay source
COPY . .

# s6-rc service definitions for codex session container
COPY s6-overlay-session/s6-rc.d /etc/s6-overlay/s6-rc.d
# Activate codex-session instead of claude-session in the user bundle
RUN rm -f /etc/s6-overlay/s6-rc.d/user/contents.d/claude-session \
    && rm -f /etc/s6-overlay/s6-rc.d/message-watchdog/dependencies.d/claude-session \
    && touch /etc/s6-overlay/s6-rc.d/user/contents.d/codex-session \
    && touch /etc/s6-overlay/s6-rc.d/user/contents.d/message-watchdog \
    && touch /etc/s6-overlay/s6-rc.d/message-watchdog/dependencies.d/codex-session \
    && chmod +x /etc/s6-overlay/s6-rc.d/codex-session/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/message-watchdog/run \
    && chmod +x /relay/scripts/codex-session-loop.sh \
    && chmod +x /relay/scripts/message-watchdog.sh

# s6-overlay is the init
ENTRYPOINT ["/init"]
