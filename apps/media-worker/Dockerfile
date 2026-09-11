# MAVERO compatibility media worker (Phase 11, GOAL B5).
#
# Minimal, self-contained image: Node 22 + ffmpeg. The worker is a separate
# deployment from the Netlify app (serverless functions must NOT run
# long-running FFmpeg jobs) — deploy on any VM/container host (Fly.io,
# Railway, a VPS behind TLS, ...). It exposes NO generic proxy surface:
# every conversion requires a signed compatibility reference minted by the
# MAVERO app.
FROM node:22-slim

# ffmpeg + ffprobe provide remux (-c copy) and transcode (libx264/aac).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first (cached layer) — the worker has ZERO runtime npm deps;
# devDependencies are only needed to compile TypeScript.
COPY package.json tsconfig.json ./
COPY src ./src
RUN npm install --no-audit --no-fund \
  && npm run build \
  && npm prune --omit=dev

ENV NODE_ENV=production \
    PORT=8787

# Required: MAVERO_COMPAT_SESSION_SECRET (the SAME secret the app signs
# compat references with). Recommended: PUBLIC_BASE_URL (https!).
EXPOSE 8787

# Unprivileged runtime user.
USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
