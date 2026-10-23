"use client";

import { useEffect, useState } from "react";
import {
  ArrowRight, BookOpen, ChevronRight, CircleAlert, FileCode2, FolderOpen, Loader2, Lock, Plus, RotateCw, Trash2,
} from "lucide-react";

import { ApiError, api } from "@/lib/api";
import type { NewProblem, ProblemSummary } from "@/lib/types";

// Mirrors CustomProblemValidator in the Java service. Java is authoritative;
// these only give feedback before a round trip.
const LIMITS = {
  title: 120,
  statement: 20_000,
  constraints: 4_000,
  starter: 50_000,
  examples: 10,
  tests: 20,
  testIo: 20_000,
};

const LANGUAGES = [
  { id: "python", label: "Python 3", supported: true },
  { id: "javascript", label: "JavaScript (not yet supported)", supported: false },
  { id: "java", label: "Java (not yet supported)", supported: false },
];

type Row = { a: string; b: string; c: string };
const emptyRow = (): Row => ({ a: "", b: "", c: "" });

const field = "field";
const mono = "field font-mono !text-[12px]";

function Label({
  children,
  hint,
  count,
  max,
}: {
  children: React.ReactNode;
  hint?: string;
  count?: number;
  max?: number;
}) {
  const over = max !== undefined && (count ?? 0) > max;
  return (
    <div className="mb-1.5 flex items-baseline gap-2">
      <span className="text-[12.5px] font-medium text-[var(--foreground-strong)]">{children}</span>
      {hint && <span className="text-[11px] text-[var(--faint)]">{hint}</span>}
      {max !== undefined && (
        <span
          className={`ml-auto font-mono text-[10px] ${over ? "text-[var(--fail)]" : "text-[var(--muted)]"}`}
        >
          {count ?? 0}/{max}
        </span>
      )}
    </div>
  );
}

function Rows({
  rows,
  setRows,
  max,
  labels,
  disabled,
  addLabel,
}: {
  rows: Row[];
  setRows: (r: Row[]) => void;
  max: number;
  labels: [string, string, string];
  disabled: boolean;
  addLabel: string;
}) {
  const update = (i: number, k: keyof Row, v: string) =>
    setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <div className="space-y-2">
      {rows.map((r, i) => (
        <div
          key={i}
          className="grid gap-2 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-2 sm:grid-cols-[1fr_1fr_1fr_auto]"
        >
          <textarea
            aria-label={`${labels[0]} ${i + 1}`}
            placeholder={labels[0]}
            value={r.a}
            onChange={(e) => update(i, "a", e.target.value)}
            disabled={disabled}
            rows={2}
            className={mono}
          />
          <textarea
            aria-label={`${labels[1]} ${i + 1}`}
            placeholder={labels[1]}
            value={r.b}
            onChange={(e) => update(i, "b", e.target.value)}
            disabled={disabled}
            rows={2}
            className={mono}
          />
          <input
            aria-label={`${labels[2]} ${i + 1}`}
            placeholder={labels[2]}
            value={r.c}
            onChange={(e) => update(i, "c", e.target.value)}
            disabled={disabled}
            className={field}
          />
          <button
            type="button"
            onClick={() => setRows(rows.filter((_, j) => j !== i))}
            disabled={disabled}
            className="icon-btn btn-danger self-start"
            aria-label={`remove ${i + 1}`}
            title="Remove"
          >
            <Trash2 size={13} />
          </button>
        </div>
      ))}
      {rows.length < max && (
        <button
          type="button"
          onClick={() => setRows([...rows, emptyRow()])}
          disabled={disabled}
          className="btn btn-ghost border !border-dashed !border-[var(--border-strong)]"
        >
          <Plus size={13} aria-hidden /> {addLabel}
        </button>
      )}
    </div>
  );
}

/**
 * The landing view: bring your own problem (primary), or open a sample or one
 * of your earlier problems. Opening anything sets ?problem=<id>, so a refresh
 * resumes the same session.
 */
export function NewProblemForm({ onOpen }: { onOpen: (id: string) => void }) {
  const [title, setTitle] = useState("");
  const [statement, setStatement] = useState("");
  const [constraints, setConstraints] = useState("");
  const [language, setLanguage] = useState("python");
  const [starter, setStarter] = useState("");
  const [examples, setExamples] = useState<Row[]>([]);
  const [tests, setTests] = useState<Row[]>([]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<ProblemSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const loadList = () => {
    setListError(null);
    api
      .listProblems()
      .then((r) => setProblems(r.problems))
      .catch((e) =>
        setListError(e instanceof ApiError ? e.message : String(e)),
      );
  };
  useEffect(loadList, []);

  const clientError = (): string | null => {
    if (!statement.trim()) return "The problem statement is required.";
    if (statement.length > LIMITS.statement) return "The statement is too long.";
    if (title.length > LIMITS.title) return "The title is too long.";
    if (constraints.length > LIMITS.constraints) return "The constraints are too long.";
    if (starter.length > LIMITS.starter) return "The code is too long.";
    if (!LANGUAGES.find((l) => l.id === language)?.supported)
      return "That language is not supported yet.";
    if (tests.some((t) => t.a.length > LIMITS.testIo || t.b.length > LIMITS.testIo))
      return "A test's input or expected output is too long.";
    return null;
  };

  const submit = async () => {
    const ce = clientError();
    if (ce) {
      setError(ce);
      return;
    }
    const body: NewProblem = {
      title: title.trim() || undefined,
      statement,
      constraints: constraints.trim() || undefined,
      language,
      starter_code: starter || undefined,
      examples: examples
        .filter((e) => e.a.trim() || e.b.trim())
        .map((e) => ({ input: e.a, output: e.b, explanation: e.c || undefined })),
      tests: tests
        .filter((t) => t.a.trim() || t.b.trim())
        .map((t) => ({ input: t.a, expected_output: t.b, label: t.c || undefined })),
    };
    setBusy(true);
    setError(null);
    try {
      const p = await api.createProblem(body);
      onOpen(p.id);
    } catch (e) {
      setError(
        e instanceof ApiError
          ? `${e.status ? `${e.status}: ` : ""}${e.message}`
          : String(e),
      );
    } finally {
      setBusy(false);
    }
  };

  const samples = problems?.filter((p) => p.kind === "curated") ?? [];
  const mine = problems?.filter((p) => p.kind === "custom") ?? [];

  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto grid max-w-6xl gap-10 px-6 py-10 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <section>
          <p className="mb-2 flex items-center gap-1.5 text-[11px] font-medium tracking-wider text-[var(--accent)] uppercase">
            <FileCode2 size={12} aria-hidden /> New session
          </p>
          <h1 className="text-[28px] leading-tight font-semibold">Bring your own problem</h1>
          <p className="mt-2 mb-8 max-w-xl text-[13.5px] leading-relaxed text-[var(--muted)]">
            Paste an exercise you are stuck on. The tutor will help you reason
            about it and debug your code — it will not hand you the answer.
          </p>

          <div className="space-y-5">
            <div>
              <Label hint="optional — defaults to the first line" count={title.length} max={LIMITS.title}>
                Title
              </Label>
              <input value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} className={field} placeholder="Count the vowels" />
            </div>

            <div>
              <Label hint="required" count={statement.length} max={LIMITS.statement}>
                Problem statement
              </Label>
              <textarea
                value={statement}
                onChange={(e) => setStatement(e.target.value)}
                disabled={busy}
                rows={7}
                className={field}
                placeholder="Read a line of text from standard input and print how many vowels it contains…"
              />
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
              <div>
                <Label hint="optional" count={constraints.length} max={LIMITS.constraints}>
                  Constraints
                </Label>
                <textarea value={constraints} onChange={(e) => setConstraints(e.target.value)} disabled={busy} rows={3} className={field} placeholder="1 ≤ length ≤ 10^5" />
              </div>
              <div>
                <Label>Language</Label>
                <select value={language} onChange={(e) => setLanguage(e.target.value)} disabled={busy} className={field}>
                  {LANGUAGES.map((l) => (
                    <option key={l.id} value={l.id} disabled={!l.supported}>
                      {l.label}
                    </option>
                  ))}
                </select>
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">
                  Your program reads <span className="font-mono text-[var(--muted)]">stdin</span> and prints its answer.
                </p>
              </div>
            </div>

            <div>
              <Label hint="optional — shown to you and the tutor" count={examples.length} max={LIMITS.examples}>
                Examples
              </Label>
              <Rows rows={examples} setRows={setExamples} max={LIMITS.examples} labels={["input", "output", "explanation"]} disabled={busy} addLabel="Add example" />
            </div>

            <div>
              <Label hint="optional — without tests, nothing can be verified" count={tests.length} max={LIMITS.tests}>
                Tests
              </Label>
              <Rows rows={tests} setRows={setTests} max={LIMITS.tests} labels={["stdin", "expected stdout", "label"]} disabled={busy} addLabel="Add test" />
            </div>

            <div>
              <Label hint="optional — starter code or what you have so far" count={starter.length} max={LIMITS.starter}>
                Your current attempt
              </Label>
              <textarea value={starter} onChange={(e) => setStarter(e.target.value)} disabled={busy} rows={8} spellCheck={false} className={mono} placeholder={"s = input()\nprint(...)"} />
            </div>

            {error && (
              <div role="alert" className="flex items-start gap-2 rounded-[var(--radius)] border border-[var(--fail)]/40 bg-[var(--fail-bg)] px-3 py-2 text-[12px] text-[var(--fail)]">
                <CircleAlert size={14} className="mt-px shrink-0" aria-hidden />
                {error}
              </div>
            )}

            <div className="flex items-center gap-3">
              <button
                onClick={submit}
                disabled={busy || !statement.trim()}
                className="btn btn-primary btn-lg"
              >
                {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}
                {busy ? "Creating…" : "Start tutoring session"}
                {!busy && <ArrowRight size={14} aria-hidden />}
              </button>
              <span className="flex items-center gap-1.5 text-[11.5px] text-[var(--muted)]">
                <Lock size={11} aria-hidden /> Your problem is private to you.
              </span>
            </div>
          </div>
        </section>

        <aside className="space-y-4 lg:pt-[92px]">
          <div className="panel overflow-hidden">
            <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--chrome)] px-3 py-2">
              <BookOpen size={13} className="text-[var(--accent)]" aria-hidden />
              <h2 className="text-[12px] font-semibold">Try a sample problem</h2>
            </div>
            <p className="px-3 pt-2.5 text-[11.5px] text-[var(--muted)]">
              Curated, with a logic-first gate and hidden tests.
            </p>
            {problems === null && !listError && (
              <p className="flex items-center gap-2 px-3 py-2 text-[11.5px] text-[var(--muted)]">
                <Loader2 size={12} className="animate-spin" aria-hidden /> Loading…
              </p>
            )}
            <ul className="p-1.5">
              {samples.map((p) => (
                <li key={p.id}>
                  <button onClick={() => onOpen(p.id)} className="group flex w-full items-center gap-2 rounded-[var(--radius)] px-2 py-1.5 text-left text-[13px] hover:bg-[var(--surface-2)]">
                    <FileCode2 size={13} className="text-[var(--faint)]" aria-hidden />
                    <span className="flex-1 truncate">{p.title}</span>
                    <ChevronRight size={13} className="text-[var(--faint)] opacity-0 group-hover:opacity-100" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className="panel overflow-hidden">
            <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--chrome)] px-3 py-2">
              <FolderOpen size={13} className="text-[var(--purple)]" aria-hidden />
              <h2 className="text-[12px] font-semibold">Your problems</h2>
            </div>
            {listError && (
              <p className="flex items-center gap-2 px-3 py-2.5 text-[11.5px] text-[var(--fail)]">
                <span className="flex-1">{listError}</span>
                <button onClick={loadList} className="icon-btn !h-6 !w-6" aria-label="Retry" title="Retry">
                  <RotateCw size={12} />
                </button>
              </p>
            )}
            {problems !== null && mine.length === 0 && (
              <p className="px-3 py-2.5 text-[11.5px] text-[var(--faint)]">None yet.</p>
            )}
            <ul className="p-1.5">
              {mine.map((p) => (
                <li key={p.id}>
                  <button onClick={() => onOpen(p.id)} className="group flex w-full items-center gap-2 rounded-[var(--radius)] px-2 py-1.5 text-left hover:bg-[var(--surface-2)]">
                    <FileCode2 size={13} className="shrink-0 text-[var(--faint)]" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px]">{p.title}</span>
                      <span className="font-mono text-[10px] text-[var(--faint)]">
                        {new Date(p.created_at).toLocaleString()}
                      </span>
                    </span>
                    <ChevronRight size={13} className="text-[var(--faint)] opacity-0 group-hover:opacity-100" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}
