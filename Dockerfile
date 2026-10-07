FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY openapi ./openapi
ENV NODE_ENV=production PORT=4111
EXPOSE 4111
USER node
CMD ["node", "--import", "tsx", "src/main.ts"]
