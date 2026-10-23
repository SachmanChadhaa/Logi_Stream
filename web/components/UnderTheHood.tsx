"use client";

import { useState } from "react";
import type { SessionView } from "@/lib/types";

/**
 * The panel that makes the architecture visible (CLAUDE.md section 9, D2-T4).
 *
 * Core, not decoration: it is how an examiner sees that the verdict is a
 * structured diagnosis rather than a chat reply, that the tutor's output was
 * machine-checked before delivery, and that one trace id spans four services.
 */
function Row({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex gap-3 py-1">
      <span className="w-36 shrink-0 text-[var(--muted)]">{label}</span>
      <span className={`min-w-0 flex-1 break-words ${mono ? "font-mono" : ""}`}>
        {children}
      </span>
    </div>
  );
}

const NONE = <span className="text-[var(--muted)]">—</span>;

export function UnderTheHood({ view }: { view: SessionView | null }) {
  const [open, setOpen] = useState(false);

  const ev = view?.last_eval;
  const ex = view?.last_execution;
  const dbg = view?.debug;
  const dx = view?.diagnosis;
  const runs = dbg?.run_history;
  const tm = view?.temporal;

  const verdictColour =
    ev?.verdict === "PASS"
      ? "text-[var(--pass)]"
      : ev?.verdict === "FLAGGED"
        ? "text-[var(--warn)]"
        : "text-[var(--fail)]";

  return (
    <div className="shrink-0 border-t border-[var(--border)] bg-[var(--surface)]">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-5 py-2 text-left text-xs font-medium text-[var(--muted)] transition-colors hover:text-[var(--foreground)]"
      >
        <span
          className={`inline-block transition-transform ${open ? "rotate-90" : ""}`}
        >
          ▸
        </span>
        Under the hood
        {ev && (
          <span className={`ml-1 font-mono ${verdictColour}`}>{ev.verdict}</span>
        )}
        {ev?.cache_hit && (
          <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--accent)]">
            cache hit
          </span>
        )}
        {dbg?.fallback_used && (
          <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--warn)]">
            fallback
          </span>
        )}
        <span className="ml-auto font-mono text-[10px]">
          {dbg?.trace_id ? `trace ${dbg.trace_id.slice(0, 8)}…` : ""}
        </span>
      </button>

      {open && (
        <div className="scroll-thin max-h-72 overflow-y-auto border-t border-[var(--border)] px-5 py-3 text-xs">
          <div className="grid gap-6 md:grid-cols-2">
            {/* ---- evaluator ---- */}
            <div>
              <h3 className="mb-1 font-semibold text-[var(--foreground)]">
                Logic evaluation
              </h3>
              {!ev ? (
                <p className="text-[var(--muted)]">
                  {view?.problem_kind === "custom"
                    ? "Your own problem has no rubric, so there is no logic gate. The tutor works from your statement, code and runs."
                    : "No logic evaluated yet."}
                </p>
              ) : (
                <>
                  <Row label="verdict">
                    <span className={verdictColour}>{ev.verdict}</span>
                  </Row>
                  <Row label="matched approach" mono>
                    {ev.matched_approach ?? NONE}
                  </Row>
                  <Row label="misconception" mono>
                    {ev.misconception_id ?? NONE}
                  </Row>
                  <Row label="confidence" mono>
                    {ev.confidence}
                  </Row>
                  <Row label="cache hit" mono>
                    {String(ev.cache_hit)}
                  </Row>
                  <Row label="missing steps">
                    {ev.missing_steps.length ? (
                      <ul className="list-disc space-y-0.5 pl-4">
                        {ev.missing_steps.map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ul>
                    ) : (
                      NONE
                    )}
                  </Row>
                  <Row label="violated invariants">
                    {ev.violated_invariants.length ? (
                      <ul className="list-disc space-y-0.5 pl-4">
                        {ev.violated_invariants.map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ul>
                    ) : (
                      NONE
                    )}
                  </Row>
                </>
              )}
            </div>

            {/* ---- verifier + graph ---- */}
            <div>
              <h3 className="mb-1 font-semibold text-[var(--foreground)]">
                Tutor verification &amp; graph
              </h3>
              <Row label="regenerations" mono>
                {dbg?.regenerations ?? 0}
              </Row>
              <Row label="fallback used" mono>
                <span
                  className={dbg?.fallback_used ? "text-[var(--warn)]" : ""}
                >
                  {String(dbg?.fallback_used ?? false)}
                </span>
              </Row>
              <Row label="verifier rejections">
                {dbg?.verifier_rejections.length ? (
                  <ul className="list-disc space-y-0.5 pl-4 text-[var(--warn)]">
                    {dbg.verifier_rejections.map((r, i) => (
                      <li key={i}>{r.reason}</li>
                    ))}
                  </ul>
                ) : (
                  NONE
                )}
              </Row>
              <Row label="node path" mono>
                {dbg?.last_node_path.length
                  ? dbg.last_node_path.join(" → ")
                  : NONE}
              </Row>
              <Row label="trace id" mono>
                {dbg?.trace_id ?? NONE}
              </Row>
              <Row label="thread id" mono>
                {view ? (
                  <span title={view.thread_id}>
                    {view.thread_id.slice(0, 24)}…
                  </span>
                ) : (
                  NONE
                )}
              </Row>

              {ex && (
                <>
                  <h3 className="mt-3 mb-1 font-semibold text-[var(--foreground)]">
                    Last execution
                  </h3>
                  <Row label="bucket" mono>
                    <span
                      className={
                        ex.bucket === "ACCEPTED"
                          ? "text-[var(--pass)]"
                          : "text-[var(--fail)]"
                      }
                    >
                      {ex.bucket}
                    </span>
                  </Row>
                  <Row label="passed" mono>
                    {ex.passed}/{ex.total}
                  </Row>
                </>
              )}

              {dx && (
                <>
                  <h3 className="mt-3 mb-1 font-semibold text-[var(--foreground)]">
                    Diagnosis{" "}
                    <span className="font-mono text-[10px] font-normal text-[var(--muted)]">
                      {dx.ranker}
                    </span>
                  </h3>
                  <p className="mb-1 text-[10px] text-[var(--muted)]">
                    Advisory ranking; scores are {dx.score_kind}.
                    {dx.model_version ? ` Booster ${dx.model_version}: synthetic-trained, unvalidated.` : ""}
                    {dx.iterations ? ` ${dx.iterations} diagnostic pass(es).` : ""}
                  </p>
                  {dx.candidates.length ? (
                    <ol className="list-decimal space-y-1 pl-4">
                      {dx.candidates.map((c) => (
                        <li key={c.id}>
                          <span className="font-mono">{c.id}</span>{" "}
                          <span className="font-mono text-[var(--muted)]">
                            (rule {c.score}
                            {c.model_score !== undefined ? ` · booster ${c.model_score}` : ""})
                          </span>
                          <div>{c.cause}</div>
                          {c.evidence.map((e, i) => (
                            <div key={i} className="font-mono text-[10px] text-[var(--muted)]">
                              evidence: {e}
                            </div>
                          ))}
                          <div className="text-[var(--accent)]">next: {c.next_action}</div>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    NONE
                  )}
                </>
              )}

              {tm && (tm.summary || tm.events.length > 0) && (
                <>
                  <h3 className="mt-3 mb-1 font-semibold text-[var(--foreground)]">
                    Temporal memory{" "}
                    <span className="font-mono text-[10px] font-normal text-[var(--muted)]">
                      rev {tm.code_revision} · {tm.ranker}
                    </span>
                  </h3>
                  <p className="mb-1">{tm.summary}</p>
                  {tm.student_state && (
                    <Row label="student state" mono>
                      {tm.student_state.label}{" "}
                      <span className="text-[var(--muted)]">
                        ({tm.student_state.model_version}, synthetic-trained, unvalidated)
                      </span>
                    </Row>
                  )}
                  {tm.hypotheses.length > 0 && (
                    <Row label="open hypotheses">
                      <ul className="list-disc space-y-0.5 pl-4">
                        {tm.hypotheses.map((h, i) => (
                          <li key={i}>{h}</li>
                        ))}
                      </ul>
                    </Row>
                  )}
                  {tm.next_action && <Row label="next action">{tm.next_action}</Row>}
                  <ul className="mt-1 space-y-0.5 font-mono text-[10px]">
                    {tm.events.slice(-8).map((e, i) => (
                      <li key={i} className={e.stale ? "text-[var(--muted)] line-through decoration-[var(--border-strong)]" : ""}>
                        {new Date(e.ts).toLocaleTimeString()} [{e.kind}, rev {e.code_revision}
                        {e.stale ? ", seen earlier" : e.source === "screen" ? ", seen on screen" : ""}] {e.text}
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {!!runs?.length && (
                <>
                  <h3 className="mt-3 mb-1 font-semibold text-[var(--foreground)]">
                    Run history
                  </h3>
                  <ul className="space-y-0.5 font-mono text-[10px]">
                    {runs.slice(-6).map((r, i) => (
                      <li key={i}>
                        {new Date(r.ts).toLocaleTimeString()} {r.bucket} {r.passed}/{r.total}
                        {" · "}code {r.code_sha} · {r.top_cause ?? "—"}
                        {r.verified ? "" : " · unverified"}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
