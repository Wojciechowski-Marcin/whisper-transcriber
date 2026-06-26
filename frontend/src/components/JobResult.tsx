import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Job, Segment, SummaryPreset, downloadUrl, fetchSubtitle } from "../lib/api";
import type { NameTaskState, SummaryState } from "../App";
import { formatDuration } from "../lib/format";

const SUMMARY_PRESET_OPTIONS: { value: SummaryPreset; label: string }[] = [
  { value: "dnd", label: "D&D session recap" },
  { value: "meeting", label: "Meeting notes" },
  { value: "call", label: "Call summary" },
  { value: "tldr", label: "General TL;DR" },
];

interface Props {
  job: Job;
  // Summary + speaker-name state is owned by App and keyed by job id, so a task
  // started here keeps updating *this* document even after the user switches
  // away, and several jobs can summarize/suggest concurrently.
  summaryState: SummaryState;
  onSummarize: (preset: SummaryPreset) => void;
  names: Record<string, string>;
  nameTask: NameTaskState;
  onSuggestNames: () => void;
  onRenameSpeaker: (label: string, value: string) => void;
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

export default function JobResult({
  job,
  summaryState,
  onSummarize,
  names,
  nameTask,
  onSuggestNames,
  onRenameSpeaker,
}: Props) {
  const [copied, setCopied] = useState(false);
  const [view, setView] = useState<View>("transcript");
  const [subs, setSubs] = useState<Partial<Record<View, string>>>({});
  const [subError, setSubError] = useState<string | null>(null);
  const [preset, setPreset] = useState<SummaryPreset>(summaryState.preset ?? "tldr");
  const [summaryCopied, setSummaryCopied] = useState(false);

  const summarizing = summaryState.running;
  const summary = summaryState.summary;
  const summaryPreset = summaryState.preset;

  // Reset purely-local view state when a different job is shown, and align the
  // preset dropdown with whatever summary that job already has.
  useEffect(() => {
    setView("transcript");
    setSubs({});
    setSubError(null);
    if (summaryState.preset) setPreset(summaryState.preset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.id]);

  async function copySummary() {
    if (!summary) return;
    await navigator.clipboard.writeText(summary);
    setSummaryCopied(true);
    setTimeout(() => setSummaryCopied(false), 1500);
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
                  onChange={(e) => onRenameSpeaker(label, e.target.value)}
                  placeholder={label}
                  className="w-32 rounded border border-slate-600 bg-slate-800 px-2 py-1 text-sm text-slate-100 focus:border-sky-400 focus:outline-none"
                />
              </div>
            );
          })}
          <button
            onClick={onSuggestNames}
            disabled={nameTask.running}
            className="rounded-md bg-slate-700 px-3 py-1.5 text-xs font-medium hover:bg-slate-600 disabled:opacity-50"
          >
            {nameTask.running ? "Suggesting…" : "Suggest names"}
          </button>
          {nameTask.error && <span className="text-xs text-red-300">{nameTask.error}</span>}
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
          onClick={() => onSummarize(preset)}
          disabled={summarizing}
          className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium hover:bg-sky-500 disabled:opacity-50"
        >
          {summarizing ? "Summarizing…" : summary ? "Re-summarize" : "Summarize"}
        </button>
        {summarizing && <span className="text-xs text-slate-400">{summaryState.progress}</span>}
        {summaryState.error && <span className="text-xs text-red-300">{summaryState.error}</span>}
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
