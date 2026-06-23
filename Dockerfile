# ─── Stage 1: build the React frontend ───
FROM node:20-slim AS frontend
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install
COPY frontend/ ./
RUN npm run build
# Output lands in /backend/static (per vite.config.ts outDir)

# ─── Stage 2: Python backend + ffmpeg, serving the built frontend ───
FROM python:3.12-slim
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY backend/pyproject.toml ./
COPY backend/app ./app
RUN pip install --no-cache-dir .

COPY --from=frontend /backend/static ./static

ENV OUTPUT_DIR=/data/outputs
VOLUME ["/data/outputs"]
EXPOSE 8080

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
