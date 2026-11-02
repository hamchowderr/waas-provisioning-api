# The website assistant's chat panel. Build from this folder: docker build agent/panel
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3200
COPY --from=build /app ./
EXPOSE 3200
# The proxy service every store's /assistant router points at (assistantLabels in src/provisioner/coolify/compose.ts).
# Docker gives the container its image's labels, so the panel declares it wherever it runs.
LABEL traefik.http.services.website-assistant-panel.loadbalancer.server.port="3200"
CMD ["npx", "next", "start"]
