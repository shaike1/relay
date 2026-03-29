FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV TERM=xterm-256color

# s6-overlay for process supervision
ARG S6_OVERLAY_VERSION=3.2.0.2
ADD https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz /tmp/s6-noarch.tar.xz
ADD https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-x86_64.tar.xz /tmp/s6-arch.tar.xz

# System deps + extract s6-overlay
RUN apt-get update && apt-get install -y \
    python3 python3-pip \
    curl wget git unzip \
    tmux openssh-client \
    jq ca-certificates \
    xz-utils \
    && rm -rf /var/lib/apt/lists/* \
    && tar -C / -Jxpf /tmp/s6-noarch.tar.xz \
    && tar -C / -Jxpf /tmp/s6-arch.tar.xz \
    && rm /tmp/s6-noarch.tar.xz /tmp/s6-arch.tar.xz

# Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"
RUN ln -sf /root/.bun/bin/bun /usr/local/bin/bun

# Node.js + Claude Code
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /relay

# MCP server deps
COPY mcp-telegram/package.json mcp-telegram/bun.lock* ./mcp-telegram/
RUN cd mcp-telegram && bun install --frozen-lockfile --silent

# Relay source
COPY . .

# s6-rc service definitions for session container (session-specific layout)
COPY s6-overlay-session/s6-rc.d /etc/s6-overlay/s6-rc.d
RUN chmod +x /etc/s6-overlay/s6-rc.d/mcp-server/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/claude-session/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/claude-update/up \
    && chmod +x /relay/scripts/claude-session-loop.sh \
    && chmod +x /relay/scripts/mcp-server-wrapper.sh

# s6-overlay is the init
ENTRYPOINT ["/init"]
