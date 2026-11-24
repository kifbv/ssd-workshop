# The builder's image (ticket 2.9), pushed to ECR `ssd-workshop-builder` by the deploy workflow and run as the Fargate
# task `ssd-workshop-builder`. Build from the repository's root:
#   docker build -f platform/builder/Dockerfile -t ssd-workshop-builder .
# Stage 1 bundles platform/builder/main.ts (./bundle.ts); stage 2 holds only Node.js, the bundle and the Claude Agent
# SDK with its Linux binary. No secret is baked in: the task gets its build id and token at start (RunTask override).
FROM public.ecr.aws/docker/library/node:22.21.1-bookworm-slim AS bundle
WORKDIR /src
COPY package.json package-lock.json ./
COPY platform/package.json platform/
COPY infra/package.json infra/
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.base.json ./
COPY platform/builder platform/builder
COPY platform/api platform/api
RUN npx tsx platform/builder/bundle.ts /out/main.mjs

FROM public.ecr.aws/docker/library/node:22.21.1-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=bundle /out/main.mjs ./main.mjs
COPY --from=bundle /src/node_modules/@anthropic-ai/claude-agent-sdk ./node_modules/@anthropic-ai/claude-agent-sdk
COPY --from=bundle /src/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64 ./node_modules/@anthropic-ai/claude-agent-sdk-linux-x64
USER node
CMD ["node", "/app/main.mjs"]
