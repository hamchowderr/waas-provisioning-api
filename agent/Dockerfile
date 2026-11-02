# The website assistant. Build from the repository root (it reads the root tsconfig.json and the
# AnyPress stores skill in mcp/skills): docker build -f agent/Dockerfile .
FROM node:22-alpine
WORKDIR /app
COPY tsconfig.json ./
COPY mcp/skills ./mcp/skills
# The official WordPress skills the assistant loads (src/assistant.ts SKILLS).
COPY .claude/skills/wp-patterns ./.claude/skills/wp-patterns
COPY .claude/skills/wp-block-themes ./.claude/skills/wp-block-themes
WORKDIR /app/agent
COPY agent/package.json agent/package-lock.json ./
RUN npm ci --omit=dev
COPY agent/tsconfig.json ./
COPY agent/src ./src
COPY agent/skills ./skills
ENV NODE_ENV=production PORT=3100
EXPOSE 3100
CMD ["node", "--import", "tsx", "src/main.ts"]
