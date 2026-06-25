import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  Job,
  Segment,
  SuggestNamesTaskResult,
  SummarizeTaskResult,
  SummaryPreset,
  downloadUrl,
  fetchSubtitle,
  fetchSummary,
  subscribeJob,
  suggestNames,
  summarizeJob,
} from "../lib/api";
import { formatDuration } from "../lib/format";

const SUMMARY_PRESET_OPTIONS: { value: SummaryPreset; label: string }[] = [
  { value: "dnd", label: "D&D session recap" },
  { value: "meeting", label: "Meeting notes" },
  { value: "call", label: "Call summary" },
  { value: "tldr", label: "General TL;DR" },
];

interface Props {
  job: Job;
}

type View = "transcript" | "srt" | "vtt";

function DownloadButton({ id, fmt }: { id: string; fmt: "txt" | "srt" | "vtt" }) {
  return (
    <a
      href={downloadUrl(id, fmt)}
      className="rounded-md bg-slate-700 px-3 py-1.5 text-sm font-medium hover:bg-slate-600"
    >
      .{fmt}
    </a>
  );
}

// Stable text/border/dot palette keyed by speaker label — 12 entries to
// cover the UI's supported speaker cap (see Dropzone's min/max_speakers).
const SPEAKER_COLORS = [
  { text: "text-sky-300", border: "border-sky-400/60", dot: "bg-sky-400" },
  { text: "text-emerald-300", border: "border-emerald-400/60", dot: "bg-emerald-400" },
  { text: "text-amber-300", border: "border-amber-400/60", dot: "bg-amber-400" },
  { text: "text-fuchsia-300", border: "border-fuchsia-400/60", dot: "bg-fuchsia-400" },
  { text: "text-rose-300", border: "border-rose-400/60", dot: "bg-rose-400" },
  { text: "text-indigo-300", border: "border-indigo-400/60", dot: "bg-indigo-400" },
  { text: "text-lime-300", border: "border-lime-400/60", dot: "bg-lime-400" },
  { text: "text-cyan-300", border: "border-cyan-400/60", dot: "bg-cyan-400" },
  { text: "text-orange-300", border: "border-orange-400/60", dot: "bg-orange-400" },
  { text: "text-violet-300", border: "border-violet-400/60", dot: "bg-violet-400" },
  { text: "text-teal-300", border: "border-teal-400/60", dot: "bg-teal-400" },
  { text: "text-pink-300", border: "border-pink-400/60", dot: "bg-pink-400" },
];

interface Turn {
  speaker: string;
  text: string;
}

function groupTurns(segments: Segment[]): Turn[] {
  const turns: Turn[] = [];
  for (const seg of segments) {
    const speaker = seg.speaker ?? "Speaker ?";
    const text = (seg.text ?? "").trim();
    if (!text) continue;
    const last = turns[turns.length - 1];
    if (last && last.speaker === speaker) last.text += " " + text;
    else turns.push({ speaker, text });
  }
  return turns;
}

function namesKey(jobId: string): string {
  return `speakerNames:${jobId}`;
}

function loadNames(jobId: string): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(namesKey(jobId)) ?? "{}");
  } catch {
    return {};
  }
}

export default function JobResult({ job }: Props) {
  const [copied, setCopied] = useState(false);
  const [view, setView] = useState<View>("transcript");
  const [subs, setSubs] = useState<Partial<Record<View, string>>>({});
  const [subError, setSubError] = useState<string | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});

  const [preset, setPreset] = useState<SummaryPreset>("tldr");
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryPreset, setSummaryPreset] = useState<SummaryPreset | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [summaryProgress, setSummaryProgress] = useState<string>("");
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [summaryCopied, setSummaryCopied] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);

  // Reset view state whenever a different job is shown.
  useEffect(() => {
    setView("transcript");
    setSubs({});
    setSubError(null);
    setNames(loadNames(job.id));
    setSummary(null);
    setSummaryPreset(null);
    setSummaryError(null);
    setSuggestError(null);
    if (job.has_summary) {
      fetchSummary(job.id)
        .then((s) => {
          setSummary(s.summary);
          setSummaryPreset(s.preset);
          setPreset(s.preset);
        })
        .catch(() => {
          /* non-fatal — summarize button still works */
        });
    }
  }, [job.id, job.has_summary]);

  function handleSummarize() {
    setSummarizing(true);
    setSummaryError(null);
    setSummaryProgress("Summarizing…");
    summarizeJob(job.id, preset)
      .then(({ task_id }) => {
        subscribeJob<SummarizeTaskResult>(task_id, {
          onProgress: (p) => setSummaryProgress(p.message || "Summarizing…"),
          onDone: (result) => {
            setSummary(result.summary);
            setSummaryPreset(result.preset);
            setSummarizing(false);
          },
          onError: (msg) => {
            setSummaryError(msg);
            setSummarizing(false);
          },
        });
      })
      .catch((e) => {
        setSummaryError((e as Error).message);
        setSummarizing(false);
      });
  }

  async function copySummary() {
    if (!summary) return;
    await navigator.clipboard.writeText(summary);
    setSummaryCopied(true);
    setTimeout(() => setSummaryCopied(false), 1500);
  }

  function handleSuggestNames() {
    setSuggesting(true);
    setSuggestError(null);
    suggestNames(job.id)
      .then(({ task_id }) => {
        subscribeJob<SuggestNamesTaskResult>(task_id, {
          onProgress: () => {},
          onDone: (result) => {
            for (const [label, name] of Object.entries(result.names)) {
              if (name) renameSpeaker(label, name);
            }
            setSuggesting(false);
          },
          onError: (msg) => {
            setSuggestError(msg);
            setSuggesting(false);
          },
        });
      })
      .catch((e) => {
        setSuggestError((e as Error).message);
        setSuggesting(false);
      });
  }

  function renameSpeaker(label: string, value: string) {
    setNames((prev) => {
      const next = { ...prev };
      if (value && value !== label) next[label] = value;
      else delete next[label];
      localStorage.setItem(namesKey(job.id), JSON.stringify(next));
      return next;
    });
  }

  function displayName(label: string): string {
    return names[label] ?? label;
  }

  // Lazily fetch the subtitle text when its tab is first opened.
  useEffect(() => {
    if (view === "transcript" || subs[view] !== undefined) return;
    let cancelled = false;
    setSubError(null);
    fetchSubtitle(job.id, view)
      .then((text) => !cancelled && setSubs((s) => ({ ...s, [view]: text })))
      .catch((e) => !cancelled && setSubError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [view, job.id, subs]);

  const turns = useMemo(
    () => (job.has_speakers && job.segments ? groupTurns(job.segments) : null),
    [job],
  );
  const speakerColor = useMemo(() => {
    const map = new Map<string, { text: string; border: string; dot: string }>();
    let i = 0;
    for (const t of turns ?? []) {
      if (!map.has(t.speaker)) map.set(t.speaker, SPEAKER_COLORS[i++ % SPEAKER_COLORS.length]);
    }
    return map;
  }, [turns]);
  const uniqueSpeakers = useMemo(() => Array.from(speakerColor.keys()), [speakerColor]);

  const currentText = view === "transcript" ? job.text ?? "" : subs[view] ?? "";

  async function copy() {
    await navigator.clipboard.writeText(currentText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function TabButton({ value, label }: { value: View; label: string }) {
    const active = view === value;
    return (
      <button
        onClick={() => setView(value)}
        className={[
          "rounded-md px-3 py-1 text-sm font-medium transition",
          active ? "bg-sky-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700",
        ].join(" ")}
      >
        {label}
      </button>
    );
  }

  return (
    <div className="w-full rounded-xl border border-slate-700 bg-slate-900/60 p-5">
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-400">
        <span className="font-medium text-slate-200">{job.filename}</span>
        <span>Language: {job.language ?? "—"}</span>
        <span>Duration: {formatDuration(job.duration)}</span>
        {job.has_speakers && (
          <span className="rounded bg-slate-700 px-2 py-0.5 text-xs text-slate-200">
            {speakerColor.size} speaker{speakerColor.size === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {job.has_segments && (
        <div className="mb-3 flex items-center gap-2">
          <TabButton value="transcript" label="Transcript" />
          <TabButton value="srt" label=".srt" />
          <TabButton value="vtt" label=".vtt" />
        </div>
      )}

      {uniqueSpeakers.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-slate-700 bg-slate-950/50 p-3">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Rename speakers
          </span>
          {uniqueSpeakers.map((label) => {
            const color = speakerColor.get(label);
            return (
              <div key={label} className="flex items-center gap-1.5">
                <span className={`h-2 w-2 rounded-full ${color?.dot ?? "bg-slate-500"}`} />
                <input
                  value={displayName(label)}
                  onChange={(e) => renameSpeaker(label, e.target.value)}
                  placeholder={label}
                  className="w-32 rounded border border-slate-600 bg-slate-800 px-2 py-1 text-sm text-slate-100 focus:border-sky-400 focus:outline-none"
                />
              </div>
            );
          })}
          <button
            onClick={handleSuggestNames}
            disabled={suggesting}
            className="rounded-md bg-slate-700 px-3 py-1.5 text-xs font-medium hover:bg-slate-600 disabled:opacity-50"
          >
            {suggesting ? "Suggesting…" : "Suggest names"}
          </button>
          {suggestError && <span className="text-xs text-red-300">{suggestError}</span>}
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-slate-700 bg-slate-950/50 p-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Summary
        </span>
        <select
          value={preset}
          onChange={(e) => setPreset(e.target.value as SummaryPreset)}
          disabled={summarizing}
          className="rounded border border-slate-600 bg-slate-800 px-2 py-1 text-sm text-slate-100 focus:border-sky-400 focus:outline-none"
        >
          {SUMMARY_PRESET_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <button
          onClick={handleSummarize}
          disabled={summarizing}
          className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium hover:bg-sky-500 disabled:opacity-50"
        >
          {summarizing ? "Summarizing…" : "Summarize"}
        </button>
        {summarizing && <span className="text-xs text-slate-400">{summaryProgress}</span>}
        {summaryError && <span className="text-xs text-red-300">{summaryError}</span>}
      </div>

      {summary && (
        <div className="mb-3 rounded-lg border border-slate-700 bg-slate-950 p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              {SUMMARY_PRESET_OPTIONS.find((o) => o.value === summaryPreset)?.label ?? "Summary"}
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={copySummary}
                className="rounded-md bg-slate-700 px-3 py-1 text-xs font-medium hover:bg-slate-600"
              >
                {summaryCopied ? "Copied!" : "Copy"}
              </button>
              <a
                href={downloadUrl(job.id, "md")}
                className="rounded-md bg-slate-700 px-3 py-1 text-xs font-medium hover:bg-slate-600"
              >
                .md
              </a>
            </div>
          </div>
          <div className="prose prose-invert prose-sm max-w-none text-slate-100">
            <ReactMarkdown>{summary}</ReactMarkdown>
          </div>
        </div>
      )}

      {view === "transcript" ? (
        turns ? (
          <div className="max-h-[34rem] space-y-4 overflow-y-auto rounded-lg border border-slate-700 bg-slate-950 p-4">
            {turns.map((t, i) => {
              const color = speakerColor.get(t.speaker);
              return (
                <div key={i} className={`border-l-2 pl-3 ${color?.border ?? "border-slate-700"}`}>
                  <span className={`mb-1 block font-semibold ${color?.text ?? "text-slate-300"}`}>
                    {displayName(t.speaker)}
                  </span>
                  <p className="text-base leading-relaxed text-slate-100">{t.text}</p>
                </div>
              );
            })}
          </div>
        ) : (
          <textarea
            readOnly
            value={job.text ?? ""}
            className="h-48 w-full resize-y rounded-lg border border-slate-700 bg-slate-950 p-3 text-sm text-slate-100 focus:outline-none"
          />
        )
      ) : subError ? (
        <div className="rounded-lg border border-red-500/50 bg-red-500/10 p-3 text-sm text-red-300">
          {subError}
        </div>
      ) : subs[view] === undefined ? (
        <div className="flex h-48 items-center justify-center rounded-lg border border-slate-700 bg-slate-950 text-sm text-slate-500">
          Loading {view.toUpperCase()} preview…
        </div>
      ) : (
        <textarea
          readOnly
          value={subs[view]}
          className="h-64 w-full resize-y rounded-lg border border-slate-700 bg-slate-950 p-3 font-mono text-xs leading-relaxed text-slate-100 focus:outline-none"
        />
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          onClick={copy}
          className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium hover:bg-sky-500"
        >
          {copied ? "Copied!" : view === "transcript" ? "Copy" : `Copy .${view}`}
        </button>
        <DownloadButton id={job.id} fmt="txt" />
        {job.has_segments ? (
          <>
            <DownloadButton id={job.id} fmt="srt" />
            <DownloadButton id={job.id} fmt="vtt" />
          </>
        ) : (
          <span className="text-xs text-slate-500">
            (subtitles unavailable — endpoint returned no timestamps)
          </span>
        )}
      </div>
    </div>
  );
}
