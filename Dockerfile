FROM node:22-alpine AS base
RUN npm install -g pnpm@10.34.9
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
COPY config ./config
RUN pnpm build && pnpm prune --prod --ignore-scripts

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/config ./config
USER node
EXPOSE 3000
CMD ["node", "dist/src/main.js"]
