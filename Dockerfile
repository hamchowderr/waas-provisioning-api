# Node 26, the active LTS line (maintained until April 2029).
FROM node:26-alpine
WORKDIR /app
# pg_dump for the daily off-site database backup (src/dbbackup.ts); matches the server (Postgres 18).
# Alpine 3.24 has it in community; the build fails here if pg_dump isn't 18.
RUN apk add --no-cache postgresql18-client && /usr/libexec/postgresql18/pg_dump --version | grep -q ' 18\.'
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY tsconfig.json ./
COPY src ./src
# The MCP server at /mcp (src/mcp.ts) and the TypeScript SDK it is built on.
COPY mcp/src ./mcp/src
COPY mcp/skills ./mcp/skills
COPY sdk/typescript/src ./sdk/typescript/src
COPY migrations ./migrations
COPY openapi ./openapi
ENV NODE_ENV=production PORT=4111 PATH=/usr/libexec/postgresql18:$PATH
EXPOSE 4111
USER node
CMD ["node", "--import", "tsx", "src/main.ts"]
