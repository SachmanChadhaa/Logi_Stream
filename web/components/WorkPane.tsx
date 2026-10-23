"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import type { Monaco } from "@monaco-editor/react";
import { ArrowRight, CircleCheck, FlaskConical, Loader2, Lock, Play, TriangleAlert } from "lucide-react";

import type { SessionView } from "@/lib/types";

/**
 * Monaco theme from the Cursor Dark palette (cursor-dark.nvim, MIT): keywords
 * cyan, strings pink-purple, numbers and functions amber, types purple,
 * comments grey italic, on the #1A1A1A editor ground.
 */
/** Monaco measures glyphs on a canvas, which cannot resolve a CSS variable. */
function editorFont(): string {
  const loaded = typeof document === "undefined"
    ? ""
    : getComputedStyle(document.documentElement).getPropertyValue("--font-geist-mono").trim();
  return [loaded, "ui-monospace", "Menlo", "Consolas", "monospace"].filter(Boolean).join(", ");
}

function defineCursorTheme(monaco: Monaco) {
  monaco.editor.defineTheme("cursor-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "", foreground: "D8DEE9" },
      { token: "comment", foreground: "6D737C", fontStyle: "italic" },
      { token: "keyword", foreground: "83D6C5" },
      { token: "string", foreground: "C582BF" },
      { token: "string.escape", foreground: "AA9BF5" },
      { token: "number", foreground: "EFB080" },
      { token: "type", foreground: "AA9BF5" },
      { token: "type.identifier", foreground: "AA9BF5" },
      { token: "identifier", foreground: "D8DEE9" },
      { token: "delimiter", foreground: "D8DEE9" },
      { token: "operator", foreground: "EFB080" },
      { token: "constant", foreground: "AA9BF5" },
      { token: "predefined", foreground: "EFB080", fontStyle: "bold" },
    ],
    colors: {
      "editor.background": "#1A1A1A",
      "editor.foreground": "#D8DEE9",
      "editorCursor.foreground": "#87C3FF",
      "editor.lineHighlightBackground": "#202020",
      "editor.lineHighlightBorder": "#00000000",
      "editor.selectionBackground": "#2E3A48",
      "editor.inactiveSelectionBackground": "#2A2A2A",
      "editorLineNumber.foreground": "#505050",
      "editorLineNumber.activeForeground": "#D8DEE9",
      "editorIndentGuide.background1": "#262626",
      "editorIndentGuide.activeBackground1": "#3A3A3A",
      "editorWhitespace.foreground": "#2E2E2E",
      "editorGutter.background": "#1A1A1A",
      "editorWidget.background": "#1F1F1F",
      "editorWidget.border": "#2A2A2A",
      "scrollbarSlider.background": "#3A3A3A80",
      "scrollbarSlider.hoverBackground": "#50505099",
    },
  });
}

// Monaco touches `window` at import time, so it MUST be client-only or the
// build fails during prerender (CLAUDE.md trap 7).
const MonacoEditor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center gap-2 text-xs text-[var(--muted)]">
      <Loader2 size={13} className="animate-spin" aria-hidden /> Loading editor…
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
    <div className="relative flex h-8 shrink-0 items-center gap-2 overflow-hidden border-b border-[var(--border)] bg-[var(--surface)] px-4 text-[12px]">
      <span className="absolute inset-x-0 top-0 h-px animate-pulse bg-gradient-to-r from-transparent via-[var(--accent)] to-transparent" aria-hidden />
      <Loader2 size={13} className="animate-spin text-[var(--accent)]" aria-hidden />
      <span>{label}</span>
      <span className="ml-auto text-[11px] text-[var(--muted)]">
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
  onCodeChange,
}: {
  onCodeChange?: (code: string) => void;
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

  // the assistant's "+ attach current code" needs what is in the editor now,
  // not what was last run
  useEffect(() => {
    onCodeChange?.(code);
  }, [code, onCodeChange]);

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
        <label className="mb-1 block text-[13px] font-semibold text-[var(--foreground-strong)]">
          Describe your algorithm in your own words
        </label>
        <p className="mb-3 text-[11.5px] text-[var(--muted)]">
          English, Hindi or Hinglish — all judged the same. No code yet.
        </p>
        <textarea
          value={logic}
          onChange={(e) => setLogic(e.target.value)}
          disabled={busy}
          placeholder="Main array ko ek hi baar traverse karunga…"
          className="field scroll-thin min-h-0 flex-1 resize-none !p-3 leading-relaxed"
        />
        <div className="mt-3 flex items-center gap-3">
          <button
            onClick={() => onSubmitLogic(logic.trim())}
            disabled={busy || !logic.trim()}
            className="btn btn-primary btn-lg"
          >
            Submit logic
            <ArrowRight size={14} aria-hidden />
          </button>
          <span className="flex items-center gap-1.5 text-[11.5px] text-[var(--muted)]">
            <Lock size={11} aria-hidden />
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
          theme="cursor-dark"
          beforeMount={defineCursorTheme}
          value={code}
          onChange={(v) => setCode(v ?? "")}
          options={{
            readOnly: busy || done,
            fontSize: 13,
            fontFamily: editorFont(),
            fontLigatures: true,
            renderLineHighlight: "line",
            cursorBlinking: "smooth",
            smoothScrolling: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            automaticLayout: true,
            padding: { top: 12 },
            tabSize: 4,
          }}
        />
      </div>
      <div className="flex shrink-0 items-center gap-3 border-t border-[var(--border)] bg-[var(--surface)] px-3 py-2">
        <button
          onClick={() => onSubmitCode(code)}
          disabled={busy || done || !code.trim()}
          className="btn btn-primary btn-lg"
        >
          <Play size={13} fill="currentColor" aria-hidden />
          Run &amp; submit
        </button>
        {done ? (
          <span className="flex items-center gap-1.5 text-[11.5px] text-[var(--pass)]">
            <CircleCheck size={12} aria-hidden /> Solved — reset to try again.
          </span>
        ) : testCount === 0 ? (
          <span className="flex items-center gap-1.5 text-[11.5px] text-[var(--warn)]">
            <TriangleAlert size={12} aria-hidden /> No tests: runs once on empty input — the result is not verified.
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-[11.5px] text-[var(--muted)]">
            <FlaskConical size={12} aria-hidden />
            Runs against all {testCount ?? view?.last_execution?.total ?? 5} tests.
          </span>
        )}
      </div>
    </div>
  );
}
