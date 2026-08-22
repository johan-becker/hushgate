# syntax=docker/dockerfile:1

# hushgate has zero runtime dependencies, so the final image is Node plus the
# compiled output and nothing else — no package manager, no build toolchain, no
# transitive supply chain to audit.

FROM node:22-alpine AS build
WORKDIR /src

# Dependencies first, so a source change does not invalidate the install layer.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build


FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    # Containers are reached from outside themselves. hushgate refuses to bind
    # anything but loopback without tenants, so define tenants in the config —
    # that refusal is the feature, not an obstacle.
    HUSHGATE_HOST=0.0.0.0 \
    HUSHGATE_PORT=8787 \
    HUSHGATE_AUDIT_PATH=/var/lib/hushgate/hushgate-audit.jsonl

WORKDIR /app
COPY --from=build /src/package.json ./package.json
COPY --from=build /src/dist ./dist

# The audit trail is the one thing that must outlive the container.
RUN mkdir -p /var/lib/hushgate && chown -R node:node /var/lib/hushgate /app

USER node
EXPOSE 8787

# No curl in the image, and no reason to add one.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HUSHGATE_PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "/app/dist/cli/main.js"]
CMD ["serve"]
