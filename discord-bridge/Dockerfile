FROM node:22-alpine
WORKDIR /discord-bridge
COPY package.json ./
RUN npm install --omit=dev --quiet
COPY index.js ./
CMD ["node", "index.js"]
