FROM node:22-slim

# Chromium deps for whatsapp-web.js (puppeteer)
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-noto-color-emoji \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /whatsapp-bridge
COPY package.json ./
RUN npm install --omit=dev --quiet
COPY index.js ./

CMD ["node", "index.js"]
