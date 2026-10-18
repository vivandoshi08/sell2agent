# Gateway image for Manufact Cloud. Build context is the repo root so the
# workspace dependency on @sa/shared resolves:
#   mcp-use deploy <repo-root> --no-github --root-dir . --dockerfile apps/marketplace/Dockerfile
FROM node:22-alpine
WORKDIR /app
RUN corepack enable
COPY . .
# Install only the gateway and what it depends on (@sa/shared).
RUN pnpm install --frozen-lockfile --filter @sa/marketplace...
RUN pnpm --filter @sa/marketplace build
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
EXPOSE 3000
CMD ["pnpm", "--filter", "@sa/marketplace", "start"]
