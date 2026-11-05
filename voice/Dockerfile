# The phone receptionist worker. Build from voice/: docker build -t anypress-receptionist voice
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY tsconfig.json ./
COPY src ./src
# The voice activity and turn models, fetched once at build time instead of on every call.
RUN node --import tsx src/main.ts download-files
ENV NODE_ENV=production
CMD ["node", "--import", "tsx", "src/main.ts", "start"]
