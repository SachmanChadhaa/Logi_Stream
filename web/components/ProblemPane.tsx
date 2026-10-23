"use client";

import { useState } from "react";
import type { Problem, SessionView } from "@/lib/types";

/** Minimal markdown: headings, bold, inline code, bullets. The seed uses no more. */
function renderMarkdown(md: string) {
  // The description is hard-wrapped at ~80 columns. Rendering each source line
  // as its own paragraph produced ragged breaks mid-sentence, so consecutive
  // non-blank, non-bullet lines are joined back into one paragraph first.
  const lines: string[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) {
      lines.push(paragraph.join(" "));
      paragraph = [];
    }
  };
  for (const raw of md.split("\n")) {
    const line = raw.trimEnd();
    const isBlock =
      !line.trim() || line.startsWith("- ") || line.startsWith("**");
    if (isBlock) {
      flush();
      lines.push(line);
    } else {
      paragraph.push(line.trim());
    }
  }
  flush();

  return lines.map((line, i) => {
    const key = `l${i}`;
    if (!line.trim()) return <div key={key} className="h-2" />;

    if (line.startsWith("**") && line.endsWith("**")) {
      return (
        <p key={key} className="mt-3 font-semibold text-[var(--foreground)]">
          {line.slice(2, -2)}
        </p>
      );
    }
    const bullet = line.startsWith("- ");
    const content = bullet ? line.slice(2) : line;

    const parts = content.split(/(`[^`]+`)/g).map((part, j) =>
      part.startsWith("`") && part.endsWith("`") ? (
        <code
          key={j}
          className="rounded bg-[var(--surface-2)] px-1 py-0.5 font-mono text-[0.85em] text-[var(--accent)]"
        >
          {part.slice(1, -1)}
        </code>
      ) : (
        <span key={j}>{part}</span>
      ),
    );

    return bullet ? (
      <li key={key} className="ml-4 list-disc text-sm leading-relaxed">
        {parts}
      </li>
    ) : (
      <p key={key} className="text-sm leading-relaxed">
        {parts}
      </p>
    );
  });
}

export function ProblemPane({
  problem,
  view,
}: {
  problem: Problem | null;
  view: SessionView | null;
}) {
  const [tab, setTab] = useState<"problem" | "logic">("problem");
  const codePhase = view?.phase === "CODE" || view?.phase === "DONE";
  const accepted = view?.accepted_logic;

  // the tab strip only appears once there is an accepted logic to show
  const showTabs = codePhase && !!accepted;
  const active = showTabs ? tab : "problem";

  return (
    <section className="flex h-full min-h-0 flex-col border-r border-[var(--border)] bg-[var(--surface)]">
      {showTabs && (
        <div className="flex shrink-0 gap-1 border-b border-[var(--border)] px-3 pt-3">
          {(
            [
              ["problem", "Problem"],
              ["logic", "Your accepted logic"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`rounded-t px-3 py-1.5 text-xs font-medium transition-colors ${
                active === id
                  ? "bg-[var(--surface-2)] text-[var(--foreground)]"
                  : "text-[var(--muted)] hover:text-[var(--foreground)]"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-5">
        {active === "logic" ? (
          <div>
            <h2 className="mb-3 text-sm font-semibold text-[var(--pass)]">
              Accepted — this is the contract your code must satisfy
            </h2>
            <p className="whitespace-pre-wrap rounded border border-[var(--border)] bg-[var(--surface-2)] p-3 text-sm leading-relaxed">
              {accepted}
            </p>
          </div>
        ) : !problem ? (
          <p className="text-sm text-[var(--muted)]">Loading problem…</p>
        ) : (
          <div>
            <h1 className="mb-3 text-xl font-semibold">{problem.title}</h1>
            {problem.kind === "custom" ? (
              // the student's own text: keep their line breaks exactly
              <p className="whitespace-pre-wrap text-sm leading-relaxed">
                {problem.description}
              </p>
            ) : (
              <div className="space-y-1">{renderMarkdown(problem.description)}</div>
            )}

            {problem.constraints && (
              <>
                <h2 className="mt-6 mb-2 text-sm font-semibold">Constraints</h2>
                <p className="whitespace-pre-wrap rounded border border-[var(--border)] bg-[var(--surface-2)] p-3 font-mono text-xs">
                  {problem.constraints}
                </p>
              </>
            )}

            {problem.examples.length > 0 && (
              <h2 className="mt-6 mb-2 text-sm font-semibold">Examples</h2>
            )}
            <div className="space-y-3">
              {problem.examples.map((ex, i) => (
                <div
                  key={i}
                  className="rounded border border-[var(--border)] bg-[var(--surface-2)] p-3"
                >
                  <div className="font-mono text-xs">
                    <div className="whitespace-pre-wrap">
                      <span className="text-[var(--muted)]">input&nbsp;&nbsp;</span>
                      {ex.input}
                    </div>
                    <div>
                      <span className="text-[var(--muted)]">output&nbsp;</span>
                      <span className="text-[var(--accent)]">{ex.output}</span>
                    </div>
                  </div>
                  {ex.explanation && (
                    <p className="mt-2 text-xs leading-relaxed text-[var(--muted)]">
                      {ex.explanation}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
