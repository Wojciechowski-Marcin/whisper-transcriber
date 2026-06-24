export interface Segment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

export interface Job {
  id: string;
  filename: string;
  model: string;
  language: string | null;
  duration: number | null;
  has_segments: boolean;
  has_speakers: boolean;
  created_at: string;
  text?: string;
  segments?: Segment[];
  // Present in history listings: "done" for persisted jobs, "running"/"error"
  // for in-flight jobs surfaced from the server's job registry.
  status?: "running" | "done" | "error";
  stage?: Stage;
  pct?: number | null;
  message?: string;
  error?: string;
}

export interface HealthInfo {
  status: string;
  upstream: string;
  model: string;
}

export type Stage =
  | "queued"
  | "converting"
  | "transcribing"
  | "saving"
  | "done"
  | "error";

export interface JobProgress {
  id: string;
  stage: Stage;
  pct: number | null;
  message: string;
  duration: number | null;
  eta_seconds: number | null;
  error?: string;
  job?: Job;
}

export interface StartOptions {
  language?: string;
  diarize?: boolean;
}

// Resolve API paths against the app's base URL so it works whether served at
// the root or under a sub-path (e.g. code-server's /proxy/8080/).
const api = (path: string): string => `${import.meta.env.BASE_URL}api/${path}`;

/** Upload a file (XHR — fetch lacks upload progress) and get back a job id. The
 *  actual transcription then runs server-side; follow it with subscribeJob. */
export function startJob(
  file: File,
  opts: StartOptions,
  onUploadProgress: (pct: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("file", file);
    if (opts.language) form.append("language", opts.language);
    if (opts.diarize) form.append("diarize", "true");

    const xhr = new XMLHttpRequest();
    xhr.open("POST", api("transcribe"));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onUploadProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText).job_id);
        } catch {
          reject(new Error("Unexpected server response"));
        }
      } else {
        let detail = `Request failed (${xhr.status})`;
        try {
          detail = JSON.parse(xhr.responseText).detail || detail;
        } catch {
          /* ignore */
        }
        reject(new Error(detail));
      }
    };
    xhr.onerror = () => reject(new Error("Network error"));
    xhr.send(form);
  });
}

interface SubscribeHandlers {
  onProgress: (p: JobProgress) => void;
  onDone: (job: Job) => void;
  onError: (message: string) => void;
}

/** Follow a job's progress. Tries SSE first (instant, low-overhead); if no event
 *  arrives quickly (e.g. a proxy buffers the stream) or the stream errors, falls
 *  back to polling the status endpoint so stages still update everywhere.
 *  Returns an unsubscribe fn. */
export function subscribeJob(jobId: string, handlers: SubscribeHandlers): () => void {
  let stopped = false;
  let polling = false;
  let es: EventSource | null = null;
  let watchdog: ReturnType<typeof setTimeout> | undefined;

  const stop = () => {
    stopped = true;
    if (watchdog) clearTimeout(watchdog);
    es?.close();
    es = null;
  };

  // Returns true once a terminal state has been handled.
  const handleSnap = (p: JobProgress): boolean => {
    if (stopped) return true;
    handlers.onProgress(p);
    if (p.stage === "done" && p.job) {
      stop();
      handlers.onDone(p.job);
      return true;
    }
    if (p.stage === "error") {
      stop();
      handlers.onError(p.error || "Transcription failed");
      return true;
    }
    return false;
  };

  async function pollLoop() {
    if (stopped || polling) return;
    polling = true;
    if (watchdog) clearTimeout(watchdog);
    es?.close();
    es = null;
    const deadline = Date.now() + 30 * 60 * 1000;
    while (!stopped && Date.now() < deadline) {
      try {
        const res = await fetch(api(`jobs/${jobId}/status`));
        if (res.ok && handleSnap((await res.json()) as JobProgress)) return;
      } catch {
        /* transient — keep polling */
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (!stopped) handlers.onError("Lost connection and the job did not finish in time");
  }

  es = new EventSource(api(`jobs/${jobId}/events`));
  // If SSE delivers nothing shortly after connecting, assume it's blocked/buffered.
  watchdog = setTimeout(pollLoop, 4000);
  es.onmessage = (ev) => {
    if (watchdog) clearTimeout(watchdog);
    try {
      handleSnap(JSON.parse(ev.data) as JobProgress);
    } catch {
      /* ignore malformed frame */
    }
  };
  es.onerror = () => {
    if (!stopped) pollLoop();
  };

  return stop;
}

export async function fetchHistory(): Promise<Job[]> {
  const res = await fetch(api("history"));
  if (!res.ok) throw new Error("Failed to load history");
  return res.json();
}

export async function fetchJob(id: string): Promise<Job> {
  const res = await fetch(api(`jobs/${id}`));
  if (!res.ok) throw new Error("Job not found");
  return res.json();
}

export async function deleteJob(id: string): Promise<void> {
  const res = await fetch(api(`jobs/${id}`), { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete");
}

export async function fetchHealth(): Promise<HealthInfo> {
  const res = await fetch(api("health"));
  return res.json();
}

export function downloadUrl(id: string, fmt: "txt" | "srt" | "vtt" | "json"): string {
  return api(`jobs/${id}/download/${fmt}`);
}

/** Fetch the raw text of a generated subtitle file (for in-UI preview). */
export async function fetchSubtitle(id: string, fmt: "srt" | "vtt"): Promise<string> {
  const res = await fetch(downloadUrl(id, fmt));
  if (!res.ok) throw new Error(`Failed to load .${fmt}`);
  return res.text();
}
