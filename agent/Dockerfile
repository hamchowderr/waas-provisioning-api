# The website assistant. Build from the repository root (it reads the root tsconfig.json and the
# AnyPress stores skill in mcp/skills): docker build -f agent/Dockerfile .
FROM node:22-alpine
WORKDIR /app
COPY tsconfig.json ./
COPY mcp/skills ./mcp/skills
WORKDIR /app/agent
COPY agent/package.json agent/package-lock.json ./
RUN npm ci --omit=dev
COPY agent/tsconfig.json ./
COPY agent/src ./src
ENV NODE_ENV=production PORT=3100
EXPOSE 3100
CMD ["node", "--import", "tsx", "src/main.ts"]
