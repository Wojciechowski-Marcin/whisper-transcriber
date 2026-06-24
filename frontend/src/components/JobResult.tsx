import { useEffect, useMemo, useState } from "react";
import { Job, Segment, downloadUrl, fetchSubtitle } from "../lib/api";
import { formatDuration } from "../lib/format";

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

// Stable palette keyed by speaker label.
const SPEAKER_COLORS = [
  "text-sky-300",
  "text-emerald-300",
  "text-amber-300",
  "text-fuchsia-300",
  "text-rose-300",
  "text-indigo-300",
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

export default function JobResult({ job }: Props) {
  const [copied, setCopied] = useState(false);
  const [view, setView] = useState<View>("transcript");
  const [subs, setSubs] = useState<Partial<Record<View, string>>>({});
  const [subError, setSubError] = useState<string | null>(null);

  // Reset view state whenever a different job is shown.
  useEffect(() => {
    setView("transcript");
    setSubs({});
    setSubError(null);
  }, [job.id]);

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
    const map = new Map<string, string>();
    let i = 0;
    for (const t of turns ?? []) {
      if (!map.has(t.speaker)) map.set(t.speaker, SPEAKER_COLORS[i++ % SPEAKER_COLORS.length]);
    }
    return map;
  }, [turns]);

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
    <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-5">
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

      {view === "transcript" ? (
        turns ? (
          <div className="max-h-80 space-y-3 overflow-y-auto rounded-lg border border-slate-700 bg-slate-950 p-3 text-sm">
            {turns.map((t, i) => (
              <div key={i}>
                <span className={`font-semibold ${speakerColor.get(t.speaker) ?? "text-slate-300"}`}>
                  {t.speaker}
                </span>
                <span className="text-slate-100">: {t.text}</span>
              </div>
            ))}
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
