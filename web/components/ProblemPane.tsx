"use client";

import { useState } from "react";
import { BookOpen, CircleCheck, FileText, Loader2 } from "lucide-react";

import type { Problem, SessionView } from "@/lib/types";

const SECTION = "mt-7 mb-2 text-[10.5px] font-semibold tracking-wider text-[var(--faint)] uppercase";

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
        <p key={key} className="mt-4 font-semibold text-[var(--foreground-strong)]">
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
          className="rounded border border-[var(--border)] bg-[var(--surface-2)] px-1 py-px font-mono text-[0.85em] text-[var(--cyan)]"
        >
          {part.slice(1, -1)}
        </code>
      ) : (
        <span key={j}>{part}</span>
      ),
    );

    return bullet ? (
      <li key={key} className="ml-4 list-disc text-[13.5px] leading-relaxed marker:text-[var(--faint)]">
        {parts}
      </li>
    ) : (
      <p key={key} className="text-[13.5px] leading-relaxed">
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
    <section className="flex h-full min-h-0 flex-col border-r border-[var(--border)] bg-[var(--background)]">
      {/* editor-style tab strip; the logic tab appears once there is one */}
      <div className="flex h-9 shrink-0 items-stretch border-b border-[var(--border)] bg-[var(--chrome)]">
        {(
          [
            ["problem", "Problem", BookOpen],
            ...(showTabs ? ([["logic", "Accepted logic", CircleCheck]] as const) : []),
          ] as const
        ).map(([id, label, Icon]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`relative flex items-center gap-1.5 border-r border-[var(--border)] px-3 text-[12px] transition-colors ${
              active === id
                ? "bg-[var(--background)] text-[var(--foreground-strong)]"
                : "text-[var(--muted)] hover:text-[var(--foreground)]"
            }`}
          >
            {active === id && <span className="absolute inset-x-0 top-0 h-px bg-[var(--accent)]" aria-hidden />}
            <Icon size={13} className={id === "logic" ? "text-[var(--pass)]" : ""} aria-hidden />
            {label}
          </button>
        ))}
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {active === "logic" ? (
          <div>
            <h2 className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-[var(--pass)]">
              <CircleCheck size={14} aria-hidden />
              Accepted — this is the contract your code must satisfy
            </h2>
            <p className="whitespace-pre-wrap rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-4 text-[13px] leading-relaxed">
              {accepted}
            </p>
          </div>
        ) : !problem ? (
          <p className="flex items-center gap-2 text-[13px] text-[var(--muted)]">
            <Loader2 size={13} className="animate-spin" aria-hidden /> Loading problem…
          </p>
        ) : (
          <div>
            <div className="mb-1 flex items-center gap-2 text-[11px] text-[var(--faint)]">
              <FileText size={12} aria-hidden />
              {problem.kind === "custom" ? "your problem" : "sample problem"} · {problem.language}
            </div>
            <h1 className="mb-4 text-[22px] font-semibold">{problem.title}</h1>
            {problem.kind === "custom" ? (
              // the student's own text: keep their line breaks exactly
              <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed">
                {problem.description}
              </p>
            ) : (
              <div className="space-y-1">{renderMarkdown(problem.description)}</div>
            )}

            {problem.constraints && (
              <>
                <h2 className={SECTION}>Constraints</h2>
                <p className="whitespace-pre-wrap rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3 font-mono text-[12px]">
                  {problem.constraints}
                </p>
              </>
            )}

            {problem.examples.length > 0 && (
              <h2 className={SECTION}>Examples</h2>
            )}
            <div className="space-y-3">
              {problem.examples.map((ex, i) => (
                <div
                  key={i}
                  className="overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]"
                >
                  <div className="border-b border-[var(--border)] bg-[var(--chrome)] px-3 py-1 text-[10.5px] text-[var(--faint)]">
                    Example {i + 1}
                  </div>
                  <div className="space-y-0.5 p-3 font-mono text-[12px]">
                    <div className="whitespace-pre-wrap">
                      <span className="text-[var(--muted)]">input&nbsp;&nbsp;</span>
                      {ex.input}
                    </div>
                    <div>
                      <span className="text-[var(--muted)]">output&nbsp;</span>
                      <span className="text-[var(--pass)]">{ex.output}</span>
                    </div>
                  </div>
                  {ex.explanation && (
                    <p className="px-3 pb-3 text-[12px] leading-relaxed text-[var(--muted)]">
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
