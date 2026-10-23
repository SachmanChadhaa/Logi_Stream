"use client";

import { useState } from "react";
import { ChevronRight, CircleCheck, CircleX, Eye, EyeOff, TriangleAlert } from "lucide-react";

import type { LastExecution, TestResult } from "@/lib/types";

const BUCKET_LABEL: Record<string, string> = {
  ACCEPTED: "All tests passed",
  WRONG_ANSWER: "Wrong answer",
  TLE: "Too slow — time limit exceeded",
  COMPILE_ERROR: "Your code could not be parsed",
  RUNTIME_ERROR: "Your code crashed while running",
  INFRA_ERROR: "The sandbox failed — this attempt does not count",
  NO_TESTS: "It ran, but there are no tests — nothing was verified",
};

function TestRow({ test }: { test: TestResult }) {
  const [open, setOpen] = useState(false);
  // a hidden test has nothing to expand: the server stripped its data
  const expandable = test.is_public || !!test.stderr_excerpt;

  return (
    <div className="border-b border-[var(--border)] last:border-b-0">
      <button
        onClick={() => expandable && setOpen((o) => !o)}
        className={`flex h-8 w-full items-center gap-3 px-4 text-left text-[12px] ${
          expandable ? "hover:bg-[var(--surface-2)]" : "cursor-default"
        }`}
      >
        <span className={`w-3 ${expandable ? "text-[var(--faint)]" : "invisible"}`}>
          <ChevronRight size={12} className={`transition-transform ${open ? "rotate-90" : ""}`} aria-hidden />
        </span>
        <span
          className={`flex items-center gap-1 font-mono text-[11px] font-medium ${test.passed ? "text-[var(--pass)]" : "text-[var(--fail)]"}`}
        >
          {test.passed ? <CircleCheck size={13} aria-hidden /> : <CircleX size={13} aria-hidden />}
          {test.passed ? "PASS" : "FAIL"}
        </span>
        <span className="font-mono text-[11px] text-[var(--faint)]">#{test.index}</span>
        <span className="flex-1 truncate">{test.label}</span>
        <span className={`tag ${test.is_public ? "!text-[var(--accent)]" : ""}`}>
          {test.is_public ? <Eye size={10} aria-hidden /> : <EyeOff size={10} aria-hidden />}
          {test.is_public ? "public" : "hidden"}
        </span>
        <span className="w-40 text-right font-mono text-[10.5px] text-[var(--muted)]">
          {test.status}
          {test.time ? ` · ${test.time}s` : ""}
        </span>
      </button>

      {open && (
        <div className="space-y-2 border-t border-[var(--border)] bg-[var(--background)] py-3 pr-4 pl-10 font-mono text-[11px]">
          {test.is_public ? (
            <>
              <div>
                <span className="text-[var(--muted)]">input</span>
                <pre className="mt-0.5 overflow-x-auto whitespace-pre-wrap break-all">
                  {test.stdin}
                </pre>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <div>
                  <span className="text-[var(--muted)]">expected</span>
                  <pre className="mt-0.5 text-[var(--pass)]">
                    {test.expected ?? (
                      <span className="text-[var(--muted)]">(no expected output)</span>
                    )}
                  </pre>
                </div>
                <div>
                  <span className="text-[var(--muted)]">your output</span>
                  <pre
                    className={`mt-0.5 ${test.passed ? "text-[var(--pass)]" : "text-[var(--fail)]"}`}
                  >
                    {test.stdout?.trim() || "(nothing)"}
                  </pre>
                </div>
              </div>
            </>
          ) : (
            <p className="text-[var(--muted)]">
              This test is hidden. Its input and expected output are never sent
              to the browser.
            </p>
          )}
          {test.stderr_excerpt && (
            <div>
              <span className="text-[var(--muted)]">error</span>
              <pre className="mt-0.5 overflow-x-auto whitespace-pre-wrap text-[var(--fail)]">
                {test.stderr_excerpt}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function TestDrawer({ execution }: { execution: LastExecution | null }) {
  const [collapsed, setCollapsed] = useState(false);
  if (!execution) return null;

  const accepted = execution.bucket === "ACCEPTED";
  const unverified = execution.bucket === "NO_TESTS";

  return (
    <div className="shrink-0 border-t border-[var(--border)] bg-[var(--surface)]">
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="flex h-9 w-full items-center gap-3 bg-[var(--chrome)] px-4 text-left hover:bg-[var(--background)]"
      >
        <ChevronRight
          size={13}
          className={`text-[var(--muted)] transition-transform ${collapsed ? "" : "rotate-90"}`}
          aria-hidden
        />
        <span className="text-[11px] font-semibold tracking-wide text-[var(--muted)] uppercase">Tests</span>
        <span
          className={`flex items-center gap-1.5 rounded-[var(--radius)] px-1.5 py-0.5 font-mono text-[11px] font-medium ${
            accepted
              ? "bg-[var(--pass-bg)] text-[var(--pass)]"
              : unverified
                ? "bg-[var(--warn-bg)] text-[var(--warn)]"
                : "bg-[var(--fail-bg)] text-[var(--fail)]"
          }`}
        >
          {accepted ? <CircleCheck size={12} aria-hidden /> : unverified ? <TriangleAlert size={12} aria-hidden /> : <CircleX size={12} aria-hidden />}
          {execution.bucket}
        </span>
        <span className="truncate text-[11.5px] text-[var(--muted)]">
          {BUCKET_LABEL[execution.bucket] ?? ""}
        </span>
        <span className="ml-auto shrink-0 font-mono text-[11.5px]">
          <span className={accepted ? "text-[var(--pass)]" : ""}>
            {execution.passed}
          </span>
          <span className="text-[var(--muted)]">
            {unverified ? " tests" : `/${execution.total} passed`}
          </span>
        </span>
      </button>

      {!collapsed && (
        <div className="scroll-thin max-h-56 overflow-y-auto border-t border-[var(--border)]">
          {execution.tests.map((t) => (
            <TestRow key={t.index} test={t} />
          ))}
        </div>
      )}
    </div>
  );
}
