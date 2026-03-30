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
    docker.io \
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

# Python deps
COPY requirements.txt .
RUN pip3 install --break-system-packages -q -r requirements.txt

# MCP server deps
COPY mcp-telegram/package.json mcp-telegram/bun.lock* ./mcp-telegram/
RUN cd mcp-telegram && bun install --frozen-lockfile --silent

# Relay source (secrets/state come in via volumes, not baked in)
COPY . .

# s6-rc service definitions
COPY s6-overlay/s6-rc.d /etc/s6-overlay/s6-rc.d
RUN chmod +x /etc/s6-overlay/s6-rc.d/bot/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/claude-update/up

# s6-overlay is the init — replaces the old entrypoint
ENTRYPOINT ["/init"]
