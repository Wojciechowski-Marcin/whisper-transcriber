import { useEffect, useRef, useState } from "react";
import Dropzone from "./components/Dropzone";
import JobResult from "./components/JobResult";
import HistoryPanel from "./components/HistoryPanel";
import ProgressCard from "./components/ProgressCard";
import {
  Job,
  JobProgress,
  HealthInfo,
  Stage,
  SummaryPreset,
  SummarizeTaskResult,
  SuggestNamesTaskResult,
  startJob,
  subscribeJob,
  summarizeJob,
  suggestNames,
  fetchSummary,
  fetchHistory,
  fetchJob,
  deleteJob,
  fetchHealth,
} from "./lib/api";

type Status = "uploading" | "converting" | "transcribing" | "saving" | "error";

// Per-job summary task + result. Keyed by job id at the App level so a task
// always updates the document it belongs to — even if the user switches the
// visible job while it runs — and several can run at once.
export interface SummaryState {
  running: boolean;
  progress: string;
  error: string | null;
  summary: string | null;
  preset: SummaryPreset | null;
}

export interface NameTaskState {
  running: boolean;
  error: string | null;
}

const namesKey = (jobId: string) => `speakerNames:${jobId}`;

function loadNames(jobId: string): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(namesKey(jobId)) ?? "{}");
  } catch {
    return {};
  }
}

interface Tracked {
  localId: string;
  jobId: string | null;
  filename: string;
  status: Status;
  uploadPct: number;
  prog: JobProgress | null;
  startedAt: number;
  unsub: (() => void) | null;
}

export default function App() {
  const [tracked, setTracked] = useState<Record<string, Tracked>>({});
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<Job | null>(null);
  const [history, setHistory] = useState<Job[]>([]);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [language, setLanguage] = useState<string>(""); // "" = auto-detect
  const [diarize, setDiarize] = useState(false);
  const [minSpeakers, setMinSpeakers] = useState<number | null>(null);
  const [maxSpeakers, setMaxSpeakers] = useState<number | null>(null);
  // Per-job LLM state, keyed by job id (see SummaryState docs above).
  const [summaries, setSummaries] = useState<Record<string, SummaryState>>({});
  const [nameTasks, setNameTasks] = useState<Record<string, NameTaskState>>({});
  const [speakerNames, setSpeakerNames] = useState<Record<string, Record<string, string>>>({});
  const trackedByJobId = useRef<Map<string, string>>(new Map()); // jobId -> localId
  const trackedRef = useRef<Record<string, Tracked>>({});
  trackedRef.current = tracked;

  // ─── Per-job summarization (keyed by jobId so results never cross documents) ───
  function startSummarize(jobId: string, preset: SummaryPreset) {
    setSummaries((prev) => ({
      ...prev,
      [jobId]: {
        running: true,
        progress: "Summarizing…",
        error: null,
        summary: prev[jobId]?.summary ?? null,
        preset: prev[jobId]?.preset ?? null,
      },
    }));
    const patchSummary = (fields: Partial<SummaryState>) =>
      setSummaries((prev) => ({ ...prev, [jobId]: { ...prev[jobId], ...fields } }));
    summarizeJob(jobId, preset)
      .then(({ task_id }) => {
        subscribeJob<SummarizeTaskResult>(task_id, {
          onProgress: (p) => patchSummary({ progress: p.message || "Summarizing…" }),
          onDone: (result) =>
            patchSummary({ running: false, summary: result.summary, preset: result.preset }),
          onError: (msg) => patchSummary({ running: false, error: msg }),
        });
      })
      .catch((e) => patchSummary({ running: false, error: (e as Error).message }));
  }

  // ─── Per-job speaker-name suggestion + manual renames ───
  function setNamesFor(jobId: string, next: Record<string, string>) {
    setSpeakerNames((prev) => ({ ...prev, [jobId]: next }));
    localStorage.setItem(namesKey(jobId), JSON.stringify(next));
  }

  function renameSpeaker(jobId: string, label: string, value: string) {
    const cur = speakerNames[jobId] ?? loadNames(jobId);
    const next = { ...cur };
    if (value && value !== label) next[label] = value;
    else delete next[label];
    setNamesFor(jobId, next);
  }

  function startSuggest(jobId: string) {
    setNameTasks((prev) => ({ ...prev, [jobId]: { running: true, error: null } }));
    suggestNames(jobId)
      .then(({ task_id }) => {
        subscribeJob<SuggestNamesTaskResult>(task_id, {
          onProgress: () => {},
          onDone: (result) => {
            const cur = { ...(speakerNames[jobId] ?? loadNames(jobId)) };
            for (const [label, name] of Object.entries(result.names)) {
              if (name && name !== label) cur[label] = name;
            }
            setNamesFor(jobId, cur);
            setNameTasks((prev) => ({ ...prev, [jobId]: { running: false, error: null } }));
          },
          onError: (msg) =>
            setNameTasks((prev) => ({ ...prev, [jobId]: { running: false, error: msg } })),
        });
      })
      .catch((e) =>
        setNameTasks((prev) => ({ ...prev, [jobId]: { running: false, error: (e as Error).message } })),
      );
  }

  async function refreshHistory() {
    try {
      setHistory(await fetchHistory());
    } catch {
      /* non-fatal */
    }
  }

  function patch(localId: string, fields: Partial<Tracked>) {
    setTracked((prev) => {
      const cur = prev[localId];
      if (!cur) return prev;
      return { ...prev, [localId]: { ...cur, ...fields } };
    });
  }

  function drop(localId: string) {
    setTracked((prev) => {
      const { [localId]: _gone, ...rest } = prev;
      return rest;
    });
  }

  // Subscribe to a job's progress and reflect it in the local tracker + history badge.
  function trackJob(localId: string, jobId: string, startedAt: number, filename: string) {
    trackedByJobId.current.set(jobId, localId);
    const unsub = subscribeJob(jobId, {
      onProgress: (p) => {
        if (p.stage !== "queued") {
          patch(localId, { prog: p, status: p.stage as Status });
        } else {
          patch(localId, { prog: p });
        }
        setHistory((prev) =>
          prev.map((j) => (j.id === p.id ? { ...j, status: "running", stage: p.stage, pct: p.pct } : j)),
        );
      },
      onDone: (job) => {
        setActive(job);
        drop(localId);
        trackedByJobId.current.delete(jobId);
        refreshHistory();
      },
      onError: (msg) => {
        setError(`${filename}: ${msg}`);
        patch(localId, { status: "error" });
        trackedByJobId.current.delete(jobId);
        refreshHistory();
      },
    });
    patch(localId, { unsub, startedAt });
  }

  // Re-attach to an already-running job (page reload, or clicking it in history).
  function resumeJob(item: Job) {
    setError(null);
    setActive(null);
    const localId = `resume-${item.id}`;
    setTracked((prev) => ({
      ...prev,
      [localId]: {
        localId,
        jobId: item.id,
        filename: item.filename,
        status: (item.stage && item.stage !== "queued" ? item.stage : "converting") as Status,
        uploadPct: 100,
        prog: {
          id: item.id,
          stage: item.stage ?? "queued",
          pct: item.pct ?? null,
          message: item.message ?? "",
          duration: item.duration ?? null,
          eta_seconds: null,
        },
        startedAt: Date.parse(item.created_at) || Date.now(),
        unsub: null,
      },
    }));
    trackJob(localId, item.id, Date.parse(item.created_at) || Date.now(), item.filename);
  }

  useEffect(() => {
    (async () => {
      let list: Job[] = [];
      try {
        list = await fetchHistory();
      } catch {
        /* non-fatal */
      }
      setHistory(list);
      list.filter((j) => j.status === "running").forEach(resumeJob);
    })();
    fetchHealth().then(setHealth).catch(() => setHealth(null));
    return () => {
      Object.values(trackedRef.current).forEach((t) => t.unsub?.());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When a job is shown, seed its saved speaker names (localStorage) and any
  // previously-generated summary (server) — unless we already have in-session
  // state for it (a running or finished task takes precedence).
  useEffect(() => {
    if (!active) return;
    const id = active.id;
    setSpeakerNames((prev) => (prev[id] ? prev : { ...prev, [id]: loadNames(id) }));
    let cancelled = false;
    const cur = summaries[id];
    if (active.has_summary && !(cur && (cur.summary || cur.running))) {
      fetchSummary(id)
        .then((s) => {
          if (cancelled) return;
          setSummaries((p) => {
            const c = p[id];
            if (c && (c.summary || c.running)) return p;
            return {
              ...p,
              [id]: { running: false, progress: "", error: null, summary: s.summary, preset: s.preset },
            };
          });
        })
        .catch(() => {
          /* non-fatal — summarize button still works */
        });
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  async function handleFiles(files: File[]) {
    setError(null);
    for (const file of files) {
      const localId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const startedAt = Date.now();
      setTracked((prev) => ({
        ...prev,
        [localId]: {
          localId,
          jobId: null,
          filename: file.name,
          status: "uploading",
          uploadPct: 0,
          prog: null,
          startedAt,
          unsub: null,
        },
      }));
      try {
        const jobId = await startJob(
          file,
          {
            language: language || undefined,
            diarize,
            minSpeakers: minSpeakers ?? undefined,
            maxSpeakers: maxSpeakers ?? undefined,
          },
          (pct) => patch(localId, { uploadPct: pct }),
        );
        patch(localId, { jobId });
        trackJob(localId, jobId, startedAt, file.name);
        refreshHistory(); // surface the new queued job in the list immediately
      } catch (e) {
        setError(`${file.name}: ${(e as Error).message}`);
        drop(localId);
      }
    }
  }

  async function selectJob(id: string) {
    const item = history.find((j) => j.id === id);
    if (item?.status === "running") {
      if (!trackedByJobId.current.has(id)) resumeJob(item);
      return;
    }
    if (item?.status === "error") {
      setActive(null);
      setError(item.error ?? "Transcription failed");
      return;
    }
    try {
      setActive(await fetchJob(id));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function removeJob(id: string) {
    await deleteJob(id);
    if (active?.id === id) setActive(null);
    refreshHistory();
  }

  const inFlight = Object.values(tracked).sort((a, b) => a.startedAt - b.startedAt);
  const activeId = active?.id ?? inFlight[0]?.jobId ?? null;

  return (
    <div className="mx-auto max-w-6xl px-4 py-10">
      <header className="mb-8 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold">🎙️ Whisper Transcriber</h1>
          <p className="text-sm text-slate-400">
            Upload audio or video — get transcript, speakers, SRT &amp; VTT.
          </p>
        </div>
        {health && (
          <div className="text-right text-xs text-slate-500">
            <div>model: {health.model}</div>
            <div>
              endpoint:{" "}
              <span className={health.upstream === "ok" ? "text-emerald-400" : "text-amber-400"}>
                {health.upstream}
              </span>
            </div>
          </div>
        )}
      </header>

      <div className="grid gap-8 md:grid-cols-[1fr_320px]">
        <main className="space-y-5">
          <Dropzone
            disabled={false}
            language={language}
            onLanguageChange={setLanguage}
            diarize={diarize}
            onDiarizeChange={setDiarize}
            minSpeakers={minSpeakers}
            onMinSpeakersChange={setMinSpeakers}
            maxSpeakers={maxSpeakers}
            onMaxSpeakersChange={setMaxSpeakers}
            onSelect={handleFiles}
          />

          {inFlight
            .filter((t) => t.status !== "error")
            .map((t) => (
              <ProgressCard
                key={t.localId}
                stage={(t.status === "uploading" ? "queued" : t.prog?.stage ?? "queued") as Stage}
                uploading={t.status === "uploading"}
                pct={t.status === "uploading" ? t.uploadPct : t.prog?.pct ?? null}
                message={
                  t.status === "uploading"
                    ? `Uploading ${t.filename}…`
                    : `${t.filename} — ${t.prog?.message ?? ""}`
                }
                etaSec={t.prog?.eta_seconds ?? null}
                startedAt={t.startedAt}
              />
            ))}

          {error && (
            <div className="rounded-lg border border-red-500/50 bg-red-500/10 p-3 text-sm text-red-300">
              {error}
            </div>
          )}
        </main>

        <aside>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">
            History
          </h2>
          <HistoryPanel
            jobs={history}
            activeId={activeId}
            onSelect={selectJob}
            onDelete={removeJob}
          />
        </aside>
      </div>

      {active && (
        <div className="mt-8">
          <JobResult
            job={active}
            summaryState={
              summaries[active.id] ?? {
                running: false,
                progress: "",
                error: null,
                summary: null,
                preset: null,
              }
            }
            onSummarize={(preset) => startSummarize(active.id, preset)}
            names={speakerNames[active.id] ?? {}}
            nameTask={nameTasks[active.id] ?? { running: false, error: null }}
            onSuggestNames={() => startSuggest(active.id)}
            onRenameSpeaker={(label, value) => renameSpeaker(active.id, label, value)}
          />
        </div>
      )}
    </div>
  );
}
