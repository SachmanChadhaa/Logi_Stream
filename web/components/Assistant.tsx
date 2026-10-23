"use client";

// The on-screen Socratic assistant (CLAUDE_CODE_BRIEF section 4).
//
// A small always-on-top panel the student keeps over their own IDE: an orb, a
// few "Try saying..." prompts, the latest Socratic reply, a text box, and
// +, mic and close controls. Opens in a Chrome Document Picture-in-Picture
// window from a click; anywhere else it floats inside the page instead.
//
// It is the SAME conversation as the main chat -- every message goes through
// the same tutor graph -- and it can only explain and ask. It never runs a
// command, edits a file or applies a fix.
//
// Voice is opt-in and off by default. Recognition is the browser's own (Chrome
// sends that audio to Google, and the panel says so); read-aloud uses the
// browser's local speech synthesis. The app records and stores no audio.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { CaptureState } from "@/lib/screenObserver";
import type { SessionView } from "@/lib/types";

type OrbState = "idle" | "listening" | "thinking" | "speaking" | "muted";

interface ObserverControls {
  state: CaptureState;
  status: string;
  unavailable: boolean;
  start: () => void;
  stop: () => void;
  pause: () => void;
  resume: () => void;
}

// --- browser APIs that TypeScript's DOM lib does not describe yet ----------
interface DocumentPiP {
  requestWindow(opts: { width: number; height: number }): Promise<Window>;
  window: Window | null;
}
type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
};

function pipApi(): DocumentPiP | null {
  return (window as unknown as { documentPictureInPicture?: DocumentPiP }).documentPictureInPicture ?? null;
}

function recognitionCtor(): (new () => Recognition) | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => Recognition;
    webkitSpeechRecognition?: new () => Recognition;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Copy the page's styles into the PiP document so the panel looks the same. */
function copyStyles(target: Document) {
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const style = target.createElement("style");
      style.textContent = Array.from(sheet.cssRules).map((r) => r.cssText).join("\n");
      target.head.appendChild(style);
    } catch {
      if (sheet.href) {
        const link = target.createElement("link");
        link.rel = "stylesheet";
        link.href = sheet.href;
        target.head.appendChild(link);
      }
    }
  }
  const theme = document.documentElement.dataset.theme;
  if (theme) target.documentElement.dataset.theme = theme;
}

/**
 * Open the Picture-in-Picture window. Must be called straight from a click
 * handler: Chrome only grants requestWindow inside a user activation. Returns
 * null when the API is missing or the student declines, and the caller shows
 * the in-page panel instead.
 */
export async function openPipWindow(onClosed: () => void): Promise<Window | null> {
  const api = pipApi();
  if (!api) return null;
  try {
    const w = await api.requestWindow({ width: 360, height: 640 });
    copyStyles(w.document);
    w.document.title = "LogiStream tutor";
    w.document.body.style.margin = "0";
    w.document.body.style.background = "var(--background)";
    w.addEventListener("pagehide", onClosed);
    return w;
  } catch {
    return null;
  }
}

/** Socratic prompts that fit where the student is right now. */
export function suggestions(view: SessionView | null): string[] {
  const ex = view?.last_execution;
  if (view?.phase === "DONE") {
    return ["What edge case might my tests miss?", "How could I explain my solution?"];
  }
  if (view?.phase === "LOGIC") {
    return ["Am I on the right track?", "Give me a small hint", "What should I think about first?"];
  }
  if (!ex) return ["How should I start?", "What should my program read and print?", "Give me a small hint"];
  if (ex.bucket === "NO_TESTS") {
    return ["How can I check my answer without tests?", "Which edge cases should I test?", "Give me a small hint"];
  }
  if (ex.bucket === "ACCEPTED") return ["What edge case might I be missing?"];
  const failing = ex.tests.find((t) => !t.passed);
  return [
    failing ? `Why does my code fail on "${failing.label}"?` : "Why does my code fail?",
    "Give me a small hint",
    "What should I check next?",
  ];
}

function lastRunText(view: SessionView | null): string {
  const ex = view?.last_execution;
  if (!ex) return "";
  const t = ex.tests.find((x) => !x.passed) ?? ex.tests[0];
  const lines = [`${ex.bucket}: ${ex.passed}/${ex.total} tests passed`];
  if (t?.is_public && t.stdout) lines.push(`output: ${t.stdout.trim().slice(0, 300)}`);
  if (t?.stderr_excerpt) lines.push(`error: ${t.stderr_excerpt.slice(0, 500)}`);
  return lines.join("\n");
}

function latestObservation(view: SessionView | null): string {
  const obs = [...(view?.temporal?.events ?? [])].reverse().find((e) => e.kind === "observation");
  if (!obs) return "";
  return `${obs.stale ? "seen earlier (before your last run)" : "seen on screen"}: ${obs.text}`;
}

export function Assistant({
  open,
  pipWindow,
  onClose,
  view,
  code,
  busy,
  onSend,
  observer,
}: {
  open: boolean;
  /** set when the panel lives in a PiP window; null = in-page panel */
  pipWindow: Window | null;
  onClose: () => void;
  view: SessionView | null;
  code: string;
  busy: boolean;
  onSend: (text: string) => void;
  observer: ObserverControls;
}) {
  const [text, setText] = useState("");
  const [attachOpen, setAttachOpen] = useState(false);
  const [attach, setAttach] = useState({ code: true, run: true, observation: true });
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [listening, setListening] = useState(false);
  const [readAloud, setReadAloud] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const recRef = useRef<Recognition | null>(null);
  const lastSpoken = useRef<string>("");

  const done = view?.phase === "DONE";
  const tutorMessages = (view?.messages ?? []).filter((m) => m.role === "tutor");
  const latestReply = tutorMessages[tutorMessages.length - 1]?.text ?? "";
  const chips = useMemo(() => suggestions(view), [view]);

  // ------------------------------------------------------------- read aloud
  useEffect(() => {
    if (!readAloud || !latestReply || latestReply === lastSpoken.current) return;
    lastSpoken.current = latestReply;
    if (!("speechSynthesis" in window)) return;
    const u = new SpeechSynthesisUtterance(latestReply);
    u.onstart = () => setSpeaking(true);
    u.onend = () => setSpeaking(false);
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  }, [latestReply, readAloud]);

  useEffect(() => {
    if (!readAloud && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      setSpeaking(false);
    }
  }, [readAloud]);

  // ------------------------------------------------------------------ voice
  const toggleMic = useCallback(() => {
    if (listening) {
      recRef.current?.stop();
      return;
    }
    const Ctor = recognitionCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = "en-IN";
    rec.interimResults = false;
    rec.continuous = false;
    rec.onresult = (e) => {
      const said = Array.from(e.results).map((r) => r[0]?.transcript ?? "").join(" ").trim();
      if (said) setText((t) => (t ? `${t} ${said}` : said));
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recRef.current = rec;
    setListening(true);
    rec.start();
  }, [listening]);

  // ------------------------------------------------------------------- send
  const attachedContext = useMemo(() => {
    const parts: { label: string; body: string }[] = [];
    if (attach.code && code.trim()) parts.push({ label: "my current code", body: code.slice(0, 4000) });
    const run = lastRunText(view);
    if (attach.run && run) parts.push({ label: "my last run", body: run });
    const obs = latestObservation(view);
    if (attach.observation && obs && observer.state !== "off") {
      parts.push({ label: "what the observer saw", body: obs });
    }
    return parts;
  }, [attach, code, view, observer.state]);

  const send = (msg: string) => {
    const body = msg.trim();
    if (!body || busy || done) return;
    const ctx = attachOpen && attachedContext.length
      ? "\n\n" + attachedContext.map((p) => `[${p.label}]\n${p.body}`).join("\n\n")
      : "";
    onSend(body + ctx);
    setText("");
    setAttachOpen(false);
  };

  const orb: OrbState = listening
    ? "listening"
    : busy
      ? "thinking"
      : speaking
        ? "speaking"
        : observer.state === "on"
          ? "idle"
          : "muted";

  if (!open) return null;

  const panel = (
    <div
      className="assistant flex h-full min-h-[560px] w-full flex-col gap-3 bg-[var(--surface)] p-4 text-[var(--foreground)]"
      role="dialog"
      aria-label="LogiStream Socratic tutor"
    >
      {/* capture status: always visible while the panel is */}
      <div className="flex items-center gap-2 text-[11px]">
        <span
          aria-hidden
          className={`h-2 w-2 rounded-full ${
            observer.state === "on"
              ? "bg-[var(--fail)] dot"
              : observer.state === "paused"
                ? "bg-[var(--warn)]"
                : "bg-[var(--border-strong)]"
          }`}
        />
        <span className="flex-1 truncate" title={observer.status}>
          {observer.state === "on" ? "Screen capture ON" : observer.state === "paused"
            ? "Screen capture PAUSED" : "Screen capture off"}
          {observer.unavailable && " · observer unavailable"}
        </span>
        {observer.state === "off" && (
          <button className="ctl-sm" onClick={observer.start}>
            Share screen
          </button>
        )}
        {observer.state === "on" && (
          <button className="ctl-sm" onClick={observer.pause}>Pause</button>
        )}
        {observer.state === "paused" && (
          <button className="ctl-sm" onClick={observer.resume}>Resume</button>
        )}
        {observer.state !== "off" && (
          <button className="ctl-sm" onClick={observer.stop}>Stop</button>
        )}
      </div>
      <p className="-mt-2 text-[10px] text-[var(--muted)]">
        {observer.status}. Frames go only to the local model on this laptop and are not stored.
      </p>

      <div className="flex justify-center py-1">
        <div className={`orb orb-${orb}`} role="img" aria-label={`assistant ${orb}`} />
      </div>

      <div>
        <h2 className="font-serif text-sm font-semibold">Try saying...</h2>
        <div className="mt-2 flex flex-wrap gap-2">
          {chips.map((c) => (
            <button key={c} className="chip" onClick={() => send(c)} disabled={busy || done}>
              {c}
            </button>
          ))}
        </div>
      </div>

      <div
        className="scroll-thin min-h-[72px] flex-1 overflow-y-auto rounded border border-[var(--border)] bg-[var(--background)] p-3 text-sm leading-relaxed whitespace-pre-wrap"
        aria-live="polite"
      >
        {busy ? (
          <span className="text-[var(--muted)]">Thinking…</span>
        ) : latestReply ? (
          latestReply
        ) : (
          <span className="text-[var(--muted)]">
            Ask anything about your problem. I will ask questions back — I will not write your code.
          </span>
        )}
      </div>

      {attachOpen && (
        <div className="rounded border border-[var(--border)] bg-[var(--surface-2)] p-2 text-[11px]">
          <p className="mb-1 font-medium">Attached to your next message:</p>
          {(["code", "run", "observation"] as const).map((k) => (
            <label key={k} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={attach[k]}
                onChange={(e) => setAttach((a) => ({ ...a, [k]: e.target.checked }))}
              />
              {k === "code" ? "current code" : k === "run" ? "last run output" : "latest observation"}
            </label>
          ))}
          {attachedContext.length ? (
            <pre className="scroll-thin mt-2 max-h-28 overflow-y-auto whitespace-pre-wrap font-mono text-[10px] text-[var(--muted)]">
              {attachedContext.map((p) => `[${p.label}]\n${p.body}`).join("\n\n")}
            </pre>
          ) : (
            <p className="mt-1 text-[var(--muted)]">Nothing to attach yet.</p>
          )}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
      >
        <label htmlFor="assistant-input" className="sr-only">Message the tutor</label>
        <input
          id="assistant-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={busy || done}
          placeholder={done ? "Solved — reset to try again" : "Type a question, press Enter"}
          className="w-full rounded border border-[var(--border)] bg-[var(--background)] p-2 text-sm outline-none focus:border-[var(--accent)] disabled:opacity-50"
        />
      </form>

      <div className="flex items-center gap-2">
        <button
          className={`ctl ${attachOpen ? "ctl-on" : ""}`}
          aria-label="Attach context to the next message"
          aria-pressed={attachOpen}
          onClick={() => setAttachOpen((o) => !o)}
        >
          +
        </button>
        <button
          className={`ctl ${listening ? "ctl-on" : ""}`}
          aria-label={listening ? "Stop listening" : "Speak your question"}
          aria-pressed={listening}
          onClick={toggleMic}
          disabled={!voiceEnabled || !recognitionCtor() || busy}
          title={voiceEnabled ? "Speak" : "Turn on voice first"}
        >
          🎙
        </button>
        <div className="flex-1" />
        <button className="ctl" aria-label="Close the assistant" onClick={onClose}>
          ✕
        </button>
      </div>

      <div className="space-y-1 border-t border-[var(--border)] pt-2 text-[10px] text-[var(--muted)]">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={voiceEnabled} onChange={(e) => setVoiceEnabled(e.target.checked)} />
          Voice input (Chrome sends your audio to Google for recognition)
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={readAloud} onChange={(e) => setReadAloud(e.target.checked)} />
          Read replies aloud (your browser&apos;s own voice, on this device)
        </label>
        <p>
          Diagnosis: <span className="font-mono">{view?.diagnosis?.ranker ?? view?.temporal?.ranker ?? "rules-v1"}</span>
          {" · "}advisory, not verified
        </p>
      </div>
    </div>
  );

  if (pipWindow) return createPortal(panel, pipWindow.document.body);

  return (
    <div className="fixed right-4 bottom-16 z-50 w-[340px] overflow-hidden rounded-lg border border-[var(--border-strong)] shadow-2xl">
      {panel}
    </div>
  );
}
