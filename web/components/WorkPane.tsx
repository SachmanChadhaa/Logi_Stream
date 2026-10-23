"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import type { SessionView } from "@/lib/types";

// Monaco touches `window` at import time, so it MUST be client-only or the
// build fails during prerender (CLAUDE.md trap 7).
const MonacoEditor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-xs text-[var(--muted)]">
      Loading editor…
    </div>
  ),
});

/** Live seconds counter, so a 90s free-tier turn does not look like a hang. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(id);
  }, []);
  return <span className="font-mono">{((now - since) / 1000).toFixed(1)}s</span>;
}

export function BusyBar({
  label,
  since,
}: {
  label: string;
  since: number;
}) {
  return (
    <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--surface-2)] px-4 py-2 text-xs">
      <span className="dot text-[var(--accent)]">●</span>
      <span>{label}</span>
      <span className="ml-auto text-[var(--muted)]">
        <Elapsed since={since} />
      </span>
    </div>
  );
}

export function WorkPane({
  view,
  starterCode,
  testCount,
  busy,
  onSubmitLogic,
  onSubmitCode,
}: {
  view: SessionView | null;
  starterCode: string;
  testCount?: number;
  busy: boolean;
  onSubmitLogic: (text: string) => void;
  onSubmitCode: (text: string) => void;
}) {
  const [logic, setLogic] = useState("");
  const [code, setCode] = useState("");
  const seededRef = useRef(false);

  const phase = view?.phase ?? "LOGIC";
  const done = phase === "DONE";

  // seed the editor with the starter code exactly once, so a re-render during
  // a run never clobbers what the student has typed
  useEffect(() => {
    if (!seededRef.current && starterCode && phase !== "LOGIC") {
      setCode((c) => c || starterCode);
      seededRef.current = true;
    }
  }, [starterCode, phase]);

  if (phase === "LOGIC") {
    return (
      <div className="flex min-h-0 flex-1 flex-col p-4">
        <label className="mb-2 block text-sm font-medium">
          Describe your algorithm in your own words
          <span className="ml-2 text-xs font-normal text-[var(--muted)]">
            English, Hindi or Hinglish — all judged the same
          </span>
        </label>
        <textarea
          value={logic}
          onChange={(e) => setLogic(e.target.value)}
          disabled={busy}
          placeholder="Main array ko ek hi baar traverse karunga…"
          className="scroll-thin min-h-0 flex-1 resize-none rounded border border-[var(--border)] bg-[var(--background)] p-3 text-sm leading-relaxed outline-none focus:border-[var(--accent)] disabled:opacity-50"
        />
        <div className="mt-3 flex items-center gap-3">
          <button
            onClick={() => onSubmitLogic(logic.trim())}
            disabled={busy || !logic.trim()}
            className="rounded bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--on-accent)] transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
          >
            Submit logic
          </button>
          <span className="text-xs text-[var(--muted)]">
            The editor unlocks once your logic is correct.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1">
        <MonacoEditor
          height="100%"
          defaultLanguage="python"
          theme="vs"
          value={code}
          onChange={(v) => setCode(v ?? "")}
          options={{
            readOnly: busy || done,
            fontSize: 13,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            automaticLayout: true,
            padding: { top: 12 },
            tabSize: 4,
          }}
        />
      </div>
      <div className="flex shrink-0 items-center gap-3 border-t border-[var(--border)] p-3">
        <button
          onClick={() => onSubmitCode(code)}
          disabled={busy || done || !code.trim()}
          className="rounded bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--on-accent)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          Run &amp; submit
        </button>
        {done ? (
          <span className="text-xs text-[var(--pass)]">
            Solved — reset to try again.
          </span>
        ) : testCount === 0 ? (
          <span className="text-xs text-[var(--warn)]">
            No tests: runs once on empty input — the result is not verified.
          </span>
        ) : (
          <span className="text-xs text-[var(--muted)]">
            Runs against all {testCount ?? view?.last_execution?.total ?? 5} tests.
          </span>
        )}
      </div>
    </div>
  );
}
