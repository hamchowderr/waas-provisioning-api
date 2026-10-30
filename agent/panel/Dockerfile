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
CMD ["npx", "next", "start"]
