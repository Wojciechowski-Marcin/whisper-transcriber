# 🎙️ Whisper Transcriber

A self-hostable web app to transcribe **audio or video** files. Drop in a file, get back a
transcript plus **SRT / VTT subtitles**, with every result **persisted** and browsable. Bring your
own transcription backend — it works with any **OpenAI-compatible** `/audio/transcriptions`
endpoint (a self-hosted [faster-whisper](https://github.com/SYSTRAN/faster-whisper) server,
OpenAI, Groq, …) configured entirely through environment variables.

> Video files are converted to audio server-side with `ffmpeg`, so `.mp4`, `.mkv`, `.mov`, `.webm`
> and friends just work alongside `.mp3`, `.m4a`, `.wav`, etc.

## Features

- 📤 Drag-and-drop upload with live progress
- 🎬 Server-side `ffmpeg` audio extraction (any audio **or** video container)
- 📝 Transcript + **SRT** + **VTT** downloads, copy-to-clipboard
- 🌐 Detected language and audio duration
- 💾 Results persisted to disk and shown in a browsable history (with delete)
- 🔌 Bring-your-own endpoint — works with self-hosted Whisper, OpenAI, Groq, …
- 🐳 Single Docker image (React frontend served by the FastAPI backend)

## Architecture

```
Browser (React/Vite/TS)
   │  multipart upload (audio | video)
   ▼
FastAPI backend
   │  1. ffmpeg → 16 kHz mono WAV
   │  2. POST to WHISPER_API_URL (response_format=verbose_json)
   │  3. build txt / srt / vtt, persist under OUTPUT_DIR
   ▼
Any OpenAI-compatible /audio/transcriptions endpoint
```

If the upstream endpoint returns segment timestamps (OpenAI `verbose_json`), SRT/VTT are produced.
If it only returns plain text, the app gracefully degrades to a text-only transcript.

## Quickstart

```bash
git clone <this-repo> whisper-transcriber && cd whisper-transcriber
cp .env.example .env          # edit WHISPER_API_URL / WHISPER_API_KEY
docker compose up --build
# open http://localhost:8080
```

## Configuration

All configuration is via environment variables (see `.env.example`):

| Variable          | Default                                              | Description |
|-------------------|------------------------------------------------------|-------------|
| `WHISPER_API_URL` | `http://192.168.40.180:9000/v1/audio/transcriptions` | OpenAI-compatible transcription endpoint |
| `WHISPER_API_KEY` | `not-needed`                                         | Sent as `Authorization: Bearer`. Use any value for unauthenticated servers |
| `WHISPER_MODEL`   | `whisper-1`                                           | Model name (`whisper-1` for OpenAI, `whisper-large-v3` for Groq; ignored by some self-hosted servers) |
| `MAX_UPLOAD_MB`   | `200`                                                | Reject uploads larger than this |
| `REQUEST_TIMEOUT` | `600`                                                | Upstream request timeout (seconds) |
| `OUTPUT_DIR`      | `/data/outputs`                                      | Where transcripts are persisted |
| `ALLOWED_ORIGINS` | `*`                                                  | CORS origins, comma-separated |

### Example endpoints

```dotenv
# Self-hosted faster-whisper
WHISPER_API_URL=http://192.168.40.180:9000/v1/audio/transcriptions
WHISPER_API_KEY=not-needed
WHISPER_MODEL=whisper-1

# OpenAI
WHISPER_API_URL=https://api.openai.com/v1/audio/transcriptions
WHISPER_API_KEY=sk-...
WHISPER_MODEL=whisper-1

# Groq
WHISPER_API_URL=https://api.groq.com/openai/v1/audio/transcriptions
WHISPER_API_KEY=gsk_...
WHISPER_MODEL=whisper-large-v3
```

## Development

```bash
# Backend (terminal 1)
cd backend
python -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"
uvicorn app.main:app --reload --port 8080

# Frontend (terminal 2) — Vite dev server proxies /api to :8080
cd frontend
npm install
npm run dev   # http://localhost:5173

# Tests
cd backend && pytest
```

`ffmpeg` must be on your `PATH` for local backend runs (the Docker image bundles it).

## API

| Method | Path                              | Description |
|--------|-----------------------------------|-------------|
| `POST` | `/api/transcribe`                 | Upload a file (`file`, optional `language`); returns the job |
| `GET`  | `/api/history`                    | List persisted jobs (newest first) |
| `GET`  | `/api/jobs/{id}`                  | Single job + transcript text |
| `GET`  | `/api/jobs/{id}/download/{fmt}`   | Download `txt` / `srt` / `vtt` / `json` |
| `DELETE` | `/api/jobs/{id}`                | Delete a job |
| `GET`  | `/api/health`                     | Health + upstream reachability |

## Note on subtitles

SRT/VTT need segment-level timestamps. The app requests OpenAI's `verbose_json` format; OpenAI and
Groq return segments natively. A self-hosted faster-whisper server must also return `segments` for
that response format — otherwise the app falls back to a text-only transcript.

## License

MIT — see [LICENSE](LICENSE).
