"use client";

import { useState } from "react";
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
        className={`flex w-full items-center gap-3 px-4 py-2 text-left text-xs ${
          expandable ? "hover:bg-[var(--surface-2)]" : "cursor-default"
        }`}
      >
        <span
          className={`font-mono ${test.passed ? "text-[var(--pass)]" : "text-[var(--fail)]"}`}
        >
          {test.passed ? "PASS" : "FAIL"}
        </span>
        <span className="font-mono text-[var(--muted)]">#{test.index}</span>
        <span className="flex-1">{test.label}</span>
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] ${
            test.is_public
              ? "bg-[var(--surface-2)] text-[var(--accent)]"
              : "bg-[var(--surface-2)] text-[var(--muted)]"
          }`}
        >
          {test.is_public ? "public" : "hidden"}
        </span>
        <span className="w-40 text-right font-mono text-[10px] text-[var(--muted)]">
          {test.status}
          {test.time ? ` · ${test.time}s` : ""}
        </span>
        {expandable && (
          <span className={`text-[var(--muted)] ${open ? "rotate-90" : ""}`}>
            ▸
          </span>
        )}
      </button>

      {open && (
        <div className="space-y-2 bg-[var(--background)] px-4 py-3 font-mono text-[11px]">
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
        className="flex w-full items-center gap-3 px-4 py-2 text-left"
      >
        <span
          className={`inline-block text-xs transition-transform ${collapsed ? "" : "rotate-90"}`}
        >
          ▸
        </span>
        <span
          className={`font-mono text-xs ${accepted ? "text-[var(--pass)]" : unverified ? "text-[var(--warn)]" : "text-[var(--fail)]"}`}
        >
          {execution.bucket}
        </span>
        <span className="text-xs text-[var(--muted)]">
          {BUCKET_LABEL[execution.bucket] ?? ""}
        </span>
        <span className="ml-auto font-mono text-xs">
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
