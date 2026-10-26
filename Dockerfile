FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile

FROM node:24-slim
WORKDIR /app
COPY --from=build /app /app
USER node
EXPOSE 8080
CMD ["node_modules/.bin/tsx", "apps/cli/src/main.ts", "server", "start", "--host", "0.0.0.0", "--port", "8080"]
