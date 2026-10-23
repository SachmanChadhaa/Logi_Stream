"use client";

import { Check, ChevronRight, Pause, Plus, Radio, RotateCcw, Sparkles, Square } from "lucide-react";

import type { Phase, SessionView } from "@/lib/types";

const STEPS: { id: Phase; label: string }[] = [
  { id: "LOGIC", label: "Logic" },
  { id: "CODE", label: "Code" },
  { id: "DONE", label: "Done" },
];

// A student's own problem has no rubric, hence no logic gate (docs/BYOP.md).
const CUSTOM_STEPS = STEPS.filter((s) => s.id !== "LOGIC");

function stepState(step: Phase, current: Phase): "done" | "active" | "todo" {
  const order: Phase[] = ["LOGIC", "CODE", "DONE"];
  const a = order.indexOf(step);
  const b = order.indexOf(current);
  if (a < b) return "done";
  if (a === b) return "active";
  return "todo";
}

/** The product mark: a small cursor-like glyph in the theme's own colours. */
export function Logo() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
      <defs>
        <linearGradient id="ls-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#85c1fc" />
          <stop offset="1" stopColor="#aa9bf5" />
        </linearGradient>
      </defs>
      <path d="M12 2 21 7v10l-9 5-9-5V7l9-5Z" fill="none" stroke="url(#ls-mark)" strokeWidth="1.6" />
      <path d="M12 7v10M8 9.5 12 7l4 2.5" fill="none" stroke="url(#ls-mark)" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function Header({
  view,
  busy,
  onReset,
  onHome,
  onAssistant,
  capture,
  onStopCapture,
}: {
  view: SessionView | null;
  busy: boolean;
  onReset?: () => void;
  onHome?: () => void;
  onAssistant?: () => void;
  /** the main-tab capture indicator: always visible while sharing is live */
  capture?: "off" | "starting" | "on" | "paused";
  onStopCapture?: () => void;
}) {
  const phase = view?.phase ?? "LOGIC";
  const custom = view?.problem_kind === "custom";
  const steps = custom ? CUSTOM_STEPS : STEPS;

  return (
    <header className="flex h-11 shrink-0 items-center gap-4 border-b border-[var(--border)] bg-[var(--chrome)] px-3">
      <div className="flex items-center gap-2">
        {onHome ? (
          <button
            onClick={onHome}
            disabled={busy}
            title="All problems"
            className="flex items-center gap-2 rounded-[var(--radius)] px-1.5 py-1 text-[13px] font-semibold text-[var(--foreground-strong)] transition-colors hover:bg-[var(--surface-2)] disabled:opacity-60"
          >
            <Logo />
            LogiStream
          </button>
        ) : (
          <span className="flex items-center gap-2 px-1.5 text-[13px] font-semibold text-[var(--foreground-strong)]">
            <Logo />
            LogiStream
          </span>
        )}
        <span className="hidden text-[11px] text-[var(--faint)] sm:inline">logic before code</span>
      </div>

      {view && (
        <nav className="flex items-center gap-1" aria-label="Progress">
          {custom && <span className="tag mr-1 !bg-[var(--accent-soft)] !text-[var(--accent)]">your problem</span>}
          {steps.map((step, i) => {
            const state = stepState(step.id, phase);
            return (
              <div key={step.id} className="flex items-center gap-1">
                {i > 0 && <ChevronRight size={12} className="text-[var(--faint)]" aria-hidden />}
                <span
                  aria-current={state === "active" ? "step" : undefined}
                  className={`flex h-6 items-center gap-1 rounded-[var(--radius)] px-2 text-[11.5px] font-medium transition-colors ${
                    state === "active"
                      ? "bg-[var(--surface-3)] text-[var(--foreground-strong)]"
                      : state === "done"
                        ? "text-[var(--pass)]"
                        : "text-[var(--faint)]"
                  }`}
                >
                  {state === "done" && <Check size={12} strokeWidth={2.5} aria-hidden />}
                  {state === "active" && <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" aria-hidden />}
                  {step.label}
                </span>
              </div>
            );
          })}
        </nav>
      )}

      <div className="ml-auto flex items-center gap-1.5 text-[11px] text-[var(--muted)]">
        {capture && capture !== "off" && (
          <span
            role="status"
            className={`flex h-6 items-center gap-1.5 rounded-[var(--radius)] px-2 ${
              capture === "paused" ? "bg-[var(--warn-bg)] text-[var(--warn)]" : "bg-[var(--fail-bg)] text-[var(--fail)]"
            }`}
          >
            {capture === "paused" ? <Pause size={11} aria-hidden /> : <Radio size={11} className={capture === "on" ? "dot" : ""} aria-hidden />}
            {capture === "paused" ? "Capture paused" : capture === "starting" ? "Choosing window…" : "Screen capture on"}
            {onStopCapture && (
              <button
                onClick={onStopCapture}
                className="ml-0.5 inline-flex h-4 w-4 items-center justify-center rounded hover:bg-black/30"
                aria-label="Stop screen capture"
                title="Stop sharing"
              >
                <Square size={9} fill="currentColor" />
              </button>
            )}
          </span>
        )}
        {view && (
          <span className="mx-1 hidden items-center gap-1.5 md:flex" title="How many times logic and code have been submitted">
            <span className="text-[var(--faint)]">attempts</span>
            <span className="font-mono text-[var(--foreground)]">
              {custom ? `${view.attempts.code} runs` : `${view.attempts.logic} logic · ${view.attempts.code} code`}
            </span>
          </span>
        )}
        {onAssistant && view && (
          <button onClick={onAssistant} className="btn btn-secondary" title="Open the always-on-top tutor">
            <Sparkles size={13} className="text-[var(--purple)]" aria-hidden />
            Assistant
          </button>
        )}
        {onHome && (
          <button onClick={onHome} disabled={busy} className="btn btn-ghost">
            <Plus size={13} aria-hidden />
            New problem
          </button>
        )}
        {onReset && view && (
          <button
            onClick={onReset}
            disabled={busy}
            title="Clears this session's conversation, runs and history"
            className="btn btn-ghost btn-danger"
          >
            <RotateCcw size={12} aria-hidden />
            Reset
          </button>
        )}
      </div>
    </header>
  );
}
