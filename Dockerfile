# TTunes: one image for Fly.io now and the home-lab server later. All config is env vars.
# Needs Node >= 22.18: the server's .ts files run on Node's built-in type stripping (no tsx at runtime).

# --- build: front end -> dist/ ---
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx vite build

# --- runtime: prod deps + server + built front end ---
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY scripts/ensure-bucket.mjs ./scripts/ensure-bucket.mjs
COPY --from=build /app/dist ./dist
# uploads/ = multer scratch (and local-disk storage when S3_BUCKET is unset); data/ = JSON catalog when
# DATABASE_URL is unset. Owned by the unprivileged built-in `node` user the server runs as.
RUN mkdir -p uploads data && chown node:node uploads data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server/index.ts"]
