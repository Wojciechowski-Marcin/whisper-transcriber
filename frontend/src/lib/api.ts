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

/** Stream a job's progress over SSE. Returns an unsubscribe fn. If the SSE
 *  connection drops before completion, falls back to polling the job (which
 *  exists on disk once finished). */
export function subscribeJob(jobId: string, handlers: SubscribeHandlers): () => void {
  const es = new EventSource(api(`jobs/${jobId}/events`));
  let finished = false;

  es.onmessage = (ev) => {
    let p: JobProgress;
    try {
      p = JSON.parse(ev.data);
    } catch {
      return;
    }
    handlers.onProgress(p);
    if (p.stage === "done" && p.job) {
      finished = true;
      es.close();
      handlers.onDone(p.job);
    } else if (p.stage === "error") {
      finished = true;
      es.close();
      handlers.onError(p.error || "Transcription failed");
    }
  };

  es.onerror = () => {
    if (finished) return;
    es.close();
    // The job keeps running server-side; poll until it lands on disk.
    pollUntilDone(jobId, handlers);
  };

  return () => {
    finished = true;
    es.close();
  };
}

async function pollUntilDone(jobId: string, handlers: SubscribeHandlers): Promise<void> {
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2500));
    try {
      const job = await fetchJob(jobId);
      handlers.onDone(job);
      return;
    } catch {
      /* not finished yet */
    }
  }
  handlers.onError("Lost connection to the server and the job did not finish in time");
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
