# Orro as one container: the FastAPI server, which also serves the built web app, with MuJoCo for scoring robot
# controllers. Built for Fly.io (fly.toml), but nothing in it is Fly-specific.
#
#   docker build -t orro .
#   docker run -p 8080:8080 -v orro-data:/data --env-file .env orro
#
# Saved batches and uploads live on the volume at /data (scripts/fly-start.sh links them into place).

# ── 1. the web app ─────────────────────────────────────────────────────────
FROM node:24-slim AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ── 2. the server ──────────────────────────────────────────────────────────
FROM python:3.12-slim-bookworm
COPY --from=ghcr.io/astral-sh/uv:0.10.12 /uv /usr/local/bin/uv

# uv installs into the image's own Python and never downloads another.
ENV PYTHONUNBUFFERED=1 \
    UV_PYTHON=/usr/local/bin/python3 \
    UV_PYTHON_DOWNLOADS=never \
    UV_LINK_MODE=copy \
    PATH="/app/.venv/bin:$PATH"
WORKDIR /app

# Dependencies first, so a code change does not reinstall them.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY . .
RUN uv sync --frozen --no-dev

# The Panda meshes the robot domain scores in (33 MB) and the Unitree G1 the push recovery domain needs in full (pinned
# commit, hash-checked; not in git).
RUN python sim/fetch_assets.py --model all
# The Unitree G1 model, for the humanoid domain and its demo batch's 3D replays (19 MB, MuJoCo Menagerie at a pinned
# commit, BSD 3-Clause, hash-checked; not in git). Without it a humanoid batch is refused at start.
RUN python -m sim.g1.fetch_assets

COPY --from=web /app/web/dist ./web/dist

RUN chmod +x scripts/fly-start.sh

EXPOSE 8080
CMD ["/app/scripts/fly-start.sh"]
