# syntax=docker/dockerfile:1

# hushgate has zero runtime dependencies, so the final image is Node, the
# compiled output, and one distribution package — no npm dependencies, no build
# toolchain, no transitive supply chain to audit.
#
# The one package is poppler-utils, for `pdftotext`. hushgate does not parse
# PDFs itself: a from-scratch extractor was written while the attachment
# feature was designed and it failed silently on ordinary documents, dropping
# names and addresses out of text that still read fluently. Refusing to guess
# is the position the rest of the product takes, so PDF extraction is delegated
# to a tool that has been doing it for twenty years, run as a separate process
# with the document on stdin, no temporary files, no network, and no access to
# this process's environment.

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

# `pdftotext` only. The rest of poppler-utils is not installed, and tesseract is
# deliberately absent: it links libcurl and will fetch a URL handed to it, which
# is not a thing that belongs inside this trust boundary.
RUN apk add --no-cache poppler-utils

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
