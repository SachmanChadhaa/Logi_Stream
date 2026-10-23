"use client";

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

export function Header({
  view,
  busy,
  onReset,
  onHome,
}: {
  view: SessionView | null;
  busy: boolean;
  onReset?: () => void;
  onHome?: () => void;
}) {
  const phase = view?.phase ?? "LOGIC";
  const custom = view?.problem_kind === "custom";
  const steps = custom ? CUSTOM_STEPS : STEPS;

  return (
    <header className="flex items-center gap-6 border-b border-[var(--border)] bg-[var(--surface)] px-5 py-3">
      <div className="flex items-baseline gap-2">
        {onHome ? (
          <button
            onClick={onHome}
            disabled={busy}
            title="All problems"
            className="text-lg font-semibold tracking-tight hover:text-[var(--accent)] disabled:opacity-60"
          >
            LogiStream
          </button>
        ) : (
          <span className="text-lg font-semibold tracking-tight">LogiStream</span>
        )}
        <span className="hidden text-xs text-[var(--muted)] sm:inline">
          logic before code
        </span>
      </div>

      {view && (
      <nav className="flex items-center gap-1" aria-label="Progress">
        {custom && (
          <span className="mr-2 rounded bg-[var(--accent-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--accent)]">
            your problem
          </span>
        )}
        {steps.map((step, i) => {
          const state = stepState(step.id, phase);
          return (
            <div key={step.id} className="flex items-center gap-1">
              {i > 0 && (
                <span
                  className={`h-px w-6 ${
                    state === "todo"
                      ? "bg-[var(--border)]"
                      : "bg-[var(--accent)]"
                  }`}
                />
              )}
              <span
                aria-current={state === "active" ? "step" : undefined}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  state === "active"
                    ? "bg-[var(--accent)] text-[var(--on-accent)]"
                    : state === "done"
                      ? "bg-[var(--surface-2)] text-[var(--accent)]"
                      : "bg-[var(--surface-2)] text-[var(--muted)]"
                }`}
              >
                {state === "done" ? "✓ " : ""}
                {step.label}
              </span>
            </div>
          );
        })}
      </nav>
      )}

      <div className="ml-auto flex items-center gap-4 text-xs text-[var(--muted)]">
        {view && (
        <span title="How many times logic and code have been submitted">
          attempts&nbsp;
          <span className="font-mono text-[var(--foreground)]">
            {custom
              ? `runs ${view.attempts.code}`
              : `logic ${view.attempts.logic} · code ${view.attempts.code}`}
          </span>
        </span>
        )}
        {onHome && (
          <button
            onClick={onHome}
            disabled={busy}
            className="rounded border border-[var(--border)] px-3 py-1 text-xs text-[var(--foreground)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            New problem
          </button>
        )}
        {onReset && view && (
        <button
          onClick={onReset}
          disabled={busy}
          title="Clears this session's conversation, runs and history"
          className="rounded border border-[var(--border)] px-3 py-1 text-xs text-[var(--foreground)] transition-colors hover:border-[var(--fail)] hover:text-[var(--fail)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          Reset
        </button>
        )}
      </div>
    </header>
  );
}
