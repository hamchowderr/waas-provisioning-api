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
# The assistant beside a demo's editor on anypress.io/try: demos run at https://demo.anypress.site, so its /.assistant
# comes here too, ahead of the demo site's own router (a longer rule, so Traefik tries it first).
LABEL traefik.http.routers.demo-assistant.entryPoints="https" \
      traefik.http.routers.demo-assistant.rule="Host(`demo.anypress.site`) && (Path(`/.assistant`) || PathPrefix(`/.assistant/`))" \
      traefik.http.routers.demo-assistant.service="website-assistant-panel@docker" \
      traefik.http.routers.demo-assistant.tls="true" \
      traefik.http.routers.demo-assistant.tls.certresolver="letsencrypt"
CMD ["npx", "next", "start"]
