# syntax=docker/dockerfile:1

# =========================================================================
# Colruyt Private Cloud (CPC) — single-image build.
#
# One container serves everything: the built React SPA, the /api routes and
# the /ws/ssh WebSocket, all on one port. Dev state (backend/data, .env, logs)
# is excluded via .dockerignore, so every container starts as a fresh,
# unconfigured app that seeds a default admin on first run.
#
#   docker build -t cpc:latest .
#   docker run -d -p 4100:4100 --env-file backend/.env -v cpc-data:/app/backend/data cpc:latest
# =========================================================================

# ---- Stage 1: build the frontend ----------------------------------------
FROM node:20-alpine AS frontend-build
WORKDIR /app/frontend
# Install deps first (cached until package files change)
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
# Build the SPA
COPY frontend/ ./
RUN npm run build

# ---- Stage 2: install backend production deps ---------------------------
FROM node:20-alpine AS backend-deps
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

# ---- Stage 3: runtime image ---------------------------------------------
FROM node:20-alpine AS runtime
ENV NODE_ENV=production \
    PORT=4100
WORKDIR /app

# Backend production dependencies + source
COPY --from=backend-deps /app/backend/node_modules ./backend/node_modules
COPY backend/package.json backend/package-lock.json ./backend/
COPY backend/src ./backend/src

# Built frontend (server.js serves this from ../../frontend/dist in production)
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

# Fresh, writable data directory (also declared as a volume). No dev data is
# copied in — the app creates empty stores + a seeded admin on first boot.
RUN mkdir -p /app/backend/data && chown -R node:node /app
VOLUME ["/app/backend/data"]

USER node
WORKDIR /app/backend
EXPOSE 4100

# Container health = backend up. Uses Node (no curl in the slim image).
HEALTHCHECK --interval=30s --timeout=4s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||4100)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "src/server.js"]
