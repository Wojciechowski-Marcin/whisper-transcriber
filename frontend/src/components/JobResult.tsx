import { useState } from "react";
import { Job, downloadUrl } from "../lib/api";
import { formatDuration } from "../lib/format";

interface Props {
  job: Job;
}

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

export default function JobResult({ job }: Props) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(job.text ?? "");
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-5">
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-400">
        <span className="font-medium text-slate-200">{job.filename}</span>
        <span>Language: {job.language ?? "—"}</span>
        <span>Duration: {formatDuration(job.duration)}</span>
      </div>

      <textarea
        readOnly
        value={job.text ?? ""}
        className="h-48 w-full resize-y rounded-lg border border-slate-700 bg-slate-950 p-3 text-sm text-slate-100 focus:outline-none"
      />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          onClick={copy}
          className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium hover:bg-sky-500"
        >
          {copied ? "Copied!" : "Copy"}
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
