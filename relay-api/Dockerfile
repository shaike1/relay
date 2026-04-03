FROM node:20-slim

# Install docker CLI for container management
RUN apt-get update && apt-get install -y --no-install-recommends \
    docker.io python3 bash curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /relay-api

COPY package.json .
RUN npm install --production

COPY server.js .

EXPOSE 9100

CMD ["node", "server.js"]
