"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, CircleAlert, FileQuestion, RotateCw, TriangleAlert, X } from "lucide-react";

import { Assistant, openPipWindow } from "@/components/Assistant";

import { ChatPanel } from "@/components/ChatPanel";
import { Header } from "@/components/Header";
import { NewProblemForm } from "@/components/NewProblemForm";
import { PasscodeGate } from "@/components/PasscodeGate";
import { ProblemPane } from "@/components/ProblemPane";
import { TestDrawer } from "@/components/TestDrawer";
import { UnderTheHood } from "@/components/UnderTheHood";
import { BusyBar, WorkPane } from "@/components/WorkPane";
import { ApiError, api } from "@/lib/api";
import { useScreenObserver } from "@/lib/screenObserver";
import type { Problem, SessionView } from "@/lib/types";

// The open problem lives in the URL (?problem=<id>), so a refresh resumes the
// same session and a sample link like ?problem=two-sum works for the demo.
// No problem in the URL means the landing page: bring your own problem.
function readProblemParam(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("problem");
}

type BusyKind = "logic" | "chat" | "code" | "reset" | "load" | null;

const CAPTURE_STILL_ON = "Screen capture is still on. Stop it from the header when you are done.";

const BUSY_LABEL: Record<Exclude<BusyKind, null>, string> = {
  logic: "Evaluating your logic…",
  chat: "Tutor is thinking…",
  code: "Running tests in the sandbox…",
  reset: "Resetting the session…",
  load: "Loading your session…",
};

export default function Page() {
  // undefined until the URL has been read on the client
  const [problemId, setProblemId] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    setProblemId(readProblemParam());
    const onPop = () => setProblemId(readProblemParam());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const open = useCallback((id: string | null) => {
    const url = id ? `?problem=${encodeURIComponent(id)}` : window.location.pathname;
    window.history.pushState(null, "", url);
    setProblemId(id);
  }, []);

  if (problemId === undefined) return <div className="h-screen" />;

  return (
    <PasscodeGate>
      {problemId === null ? (
        <div className="flex h-screen flex-col overflow-hidden">
          <Header view={null} busy={false} />
          <NewProblemForm onOpen={open} />
        </div>
      ) : (
        // keyed so switching problems starts from a clean slate
        <Session key={problemId} problemId={problemId} onHome={() => open(null)} />
      )}
    </PasscodeGate>
  );
}

function Session({ problemId, onHome }: { problemId: string; onHome: () => void }) {
  const [problem, setProblem] = useState<Problem | null>(null);
  const [view, setView] = useState<SessionView | null>(null);
  const [busy, setBusy] = useState<BusyKind>(null);
  const [busySince, setBusySince] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [pipWindow, setPipWindow] = useState<Window | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [code, setCode] = useState("");

  const lastTutorCount = useRef(0);

  const begin = (kind: Exclude<BusyKind, null>) => {
    setBusy(kind);
    setBusySince(Date.now());
    setError(null);
  };

  const fail = (e: unknown) => {
    if (e instanceof ApiError) {
      setError(
        e.status ? `${e.status}: ${e.message}` : e.message,
      );
    } else {
      setError(String(e));
    }
  };

  // On load: fetch the problem and resume (or begin) the session. A refresh
  // must land back in the same conversation -- that is the checkpointing claim,
  // and the demo shows it by refreshing the page mid-flow.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      begin("load");
      try {
        const [p, v] = await Promise.all([
          api.getProblem(problemId),
          api.start(problemId),
        ]);
        if (cancelled) return;
        setProblem(p);
        setView(v);
        lastTutorCount.current = v.messages.filter(
          (m) => m.role === "tutor",
        ).length;
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 404) setNotFound(true);
        fail(e);
      } finally {
        if (!cancelled) setBusy(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [problemId, attempt]);

  // open the chat by itself whenever a NEW tutor message arrives
  useEffect(() => {
    if (!view) return;
    const tutors = view.messages.filter((m) => m.role === "tutor").length;
    if (tutors > lastTutorCount.current) {
      setChatOpen(true);
    }
    lastTutorCount.current = tutors;
  }, [view]);

  const send = useCallback(
    async (kind: "logic" | "chat" | "code", text: string) => {
      if (!text.trim()) return;
      begin(kind);
      try {
        setView(await api.event(problemId, kind, text));
      } catch (e) {
        fail(e);
      } finally {
        setBusy(null);
      }
    },
    [problemId],
  );

  const onReset = useCallback(async () => {
    begin("reset");
    try {
      await api.reset(problemId);
      const v = await api.start(problemId);
      setView(v);
      lastTutorCount.current = 0;
      setChatOpen(false);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  }, [problemId]);

  const isBusy = busy !== null;
  const done = view?.phase === "DONE";

  const observer = useScreenObserver({
    problemId,
    codeRevision: view?.temporal?.code_revision ?? 0,
    canSend: !isBusy && !!view && !done,
    onView: setView,
  });

  // after a run, look at the screen once more (the run may have changed what
  // the student sees) -- a tick later, once the busy flag has cleared
  const lastRunBucket = useRef<string | null>(null);
  useEffect(() => {
    const b = view?.last_execution?.bucket ?? null;
    const rev = view?.temporal?.code_revision;
    if (b && rev && `${rev}` !== lastRunBucket.current && observer.state === "on") {
      lastRunBucket.current = `${rev}`;
      const t = setTimeout(() => observer.sample(b === "ACCEPTED" ? "run" : "error"), 400);
      return () => clearTimeout(t);
    }
  }, [view, observer]);

  const closeAssistant = useCallback(() => {
    setAssistantOpen(false);
    setPipWindow((w) => {
      w?.close();
      return null;
    });
    // only a live share deserves the warning; a picker that was still open
    // ("starting") ends as cancelled or on, and "on" shows in the header
    if (observer.state === "on" || observer.state === "paused") {
      setNotice(CAPTURE_STILL_ON);
    }
  }, [observer.state]);
  useEffect(() => {
    if (observer.state === "off") setNotice((n) => (n === CAPTURE_STILL_ON ? null : n));
  }, [observer.state]);
  const closeRef = useRef(closeAssistant);
  closeRef.current = closeAssistant;

  if (notFound) {
    return (
      <div className="flex h-screen flex-col overflow-hidden">
        <Header view={null} busy={false} onHome={onHome} />
        <div className="mx-auto mt-24 flex max-w-md flex-col items-center px-4 text-center">
          <FileQuestion size={28} className="text-[var(--faint)]" aria-hidden />
          <h1 className="mt-3 text-[18px] font-semibold">Problem not found</h1>
          <p className="mt-1.5 text-[13px] text-[var(--muted)]">
            It does not exist, or it belongs to someone else.
          </p>
          <button onClick={onHome} className="btn btn-secondary btn-lg mt-5">
            <ArrowLeft size={14} aria-hidden />
            Back to problems
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <Header
        view={view}
        busy={isBusy}
        onReset={onReset}
        onHome={() => {
          observer.stop();
          onHome();
        }}
        onAssistant={async () => {
          if (assistantOpen) return;
          // straight from the click: Chrome only opens PiP inside a user gesture
          // closing the PiP window goes through closeAssistant too, so a live
          // capture is never ended -- or forgotten -- silently
          const w = await openPipWindow(() => closeRef.current());
          setPipWindow(w);
          setAssistantOpen(true);
        }}
        capture={observer.state}
        onStopCapture={observer.stop}
      />

      {notice && (
        <div role="status" className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--warn-bg)] px-4 py-1.5 text-[12px] text-[var(--warn)]">
          <TriangleAlert size={13} className="shrink-0" aria-hidden />
          <span className="flex-1">{notice}</span>
          <button onClick={() => setNotice(null)} className="icon-btn !h-6 !w-6" aria-label="Dismiss">
            <X size={13} />
          </button>
        </div>
      )}

      {error && (
        <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--fail-bg)] px-4 py-1.5 text-[12px] text-[var(--fail)]">
          <CircleAlert size={13} className="shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 break-words">{error}</span>
          {!view && (
            <button onClick={() => setAttempt((a) => a + 1)} className="btn btn-ghost !h-6 !text-[var(--fail)]">
              <RotateCw size={12} aria-hidden /> Retry
            </button>
          )}
          <button onClick={() => setError(null)} className="icon-btn !h-6 !w-6" aria-label="Dismiss">
            <X size={13} />
          </button>
        </div>
      )}

      <main className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <ProblemPane problem={problem} view={view} />

        <section className="relative flex min-h-0 flex-col bg-[var(--surface)]">
          {isBusy && <BusyBar label={BUSY_LABEL[busy]} since={busySince} />}

          <WorkPane
            view={view}
            starterCode={problem?.starter_code ?? ""}
            testCount={problem?.test_count}
            busy={isBusy}
            onSubmitLogic={(t) => send("logic", t)}
            onSubmitCode={(t) => send("code", t)}
            onCodeChange={setCode}
          />

          <TestDrawer execution={view?.last_execution ?? null} />

          <ChatPanel
            messages={view?.messages ?? []}
            open={chatOpen}
            onOpenChange={setChatOpen}
            onSend={(t) => send("chat", t)}
            busy={busy === "chat"}
            disabled={isBusy || done || !view}
            done={done}
          />
        </section>
      </main>

      <UnderTheHood view={view} />

      <Assistant
        open={assistantOpen}
        pipWindow={pipWindow}
        onClose={closeAssistant}
        view={view}
        code={code}
        busy={isBusy}
        onSend={(t) => send("chat", t)}
        observer={observer}
      />
    </div>
  );
}
