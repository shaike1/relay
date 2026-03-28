FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV TERM=xterm-256color

# System deps
RUN apt-get update && apt-get install -y \
    python3 python3-pip \
    curl wget git unzip \
    tmux openssh-client \
    jq ca-certificates \
    && rm -rf /var/lib/apt/lists/*

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

COPY docker-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
