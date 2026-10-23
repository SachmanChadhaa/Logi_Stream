"use client";

// The on-screen Socratic assistant (CLAUDE_CODE_BRIEF section 4).
//
// A small always-on-top panel the student keeps over their own IDE: a Siri-style orb, a
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
import {
  Activity, ArrowUp, CornerDownRight, Loader2, Mic, MicOff, MonitorOff, Paperclip, Pause, Play,
  Plus, Radio, ScreenShare, ShieldCheck, Sparkles, Square, Volume2, X,
} from "lucide-react";

import type { CaptureState } from "@/lib/screenObserver";
import type { SessionView } from "@/lib/types";

export type OrbState = "idle" | "listening" | "thinking" | "speaking" | "muted";

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
    w.document.body.style.background = "var(--surface)";
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

  const live = observer.state === "on";
  const paused = observer.state === "paused";
  const canSend = !!text.trim() && !busy && !done;

  const panel = (
    <div
      className={`assistant flex w-full flex-col bg-[var(--surface)] text-[var(--foreground)] ${pipWindow ? "h-screen" : "h-[600px]"}`}
      role="dialog"
      aria-label="LogiStream Socratic tutor"
    >
      {/* title bar + capture controls: always visible while the panel is */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--chrome)] px-3">
        <Sparkles size={14} className="text-[var(--purple)]" aria-hidden />
        <span className="text-[12px] font-semibold text-[var(--foreground-strong)]">Tutor</span>
        <span
          className={`tag ml-1 ${live ? "!bg-[var(--fail-bg)] !text-[var(--fail)]" : paused ? "!bg-[var(--warn-bg)] !text-[var(--warn)]" : ""}`}
          title={observer.status}
        >
          {live ? <Radio size={10} className="dot" aria-hidden /> : paused ? <Pause size={10} aria-hidden /> : <MonitorOff size={10} aria-hidden />}
          {live ? "Sharing" : paused ? "Paused" : "Not sharing"}
        </span>
        <div className="ml-auto flex items-center">
          {observer.state === "off" && (
            <button className="btn btn-ghost !h-6 !px-2 !text-[11px]" onClick={observer.start} title="Share a window with the local vision model">
              <ScreenShare size={13} aria-hidden /> Share screen
            </button>
          )}
          {live && (
            <button className="icon-btn !h-6 !w-6" onClick={observer.pause} aria-label="Pause screen capture" title="Pause">
              <Pause size={13} />
            </button>
          )}
          {paused && (
            <button className="icon-btn !h-6 !w-6" onClick={observer.resume} aria-label="Resume screen capture" title="Resume">
              <Play size={13} />
            </button>
          )}
          {observer.state !== "off" && (
            <button className="icon-btn !h-6 !w-6" onClick={observer.stop} aria-label="Stop screen capture" title="Stop sharing">
              <Square size={12} />
            </button>
          )}
          <button className="icon-btn !h-6 !w-6" aria-label="Close the assistant" title="Close" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
      </div>

      <p className="flex items-start gap-1.5 px-3 pt-2 text-[10.5px] leading-snug text-[var(--muted)]">
        <ShieldCheck size={11} className="mt-px shrink-0" aria-hidden />
        <span>
          {observer.status}
          {observer.unavailable && " · observer unavailable"}. Frames go only to the local model on this laptop
          and are never stored.
        </span>
      </p>

      <div className="flex shrink-0 flex-col items-center gap-2 pt-4 pb-3">
        <SiriOrb state={orb} size={92} />
        <span className="text-[11px] tracking-wide text-[var(--muted)]">{ORB_LABEL[orb]}</span>
      </div>

      <div
        className="scroll-thin mx-3 min-h-[72px] flex-1 overflow-y-auto rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--background)] px-3 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap"
        aria-live="polite"
      >
        {busy ? (
          <span className="flex items-center gap-2 text-[var(--muted)]">
            <Loader2 size={13} className="animate-spin" aria-hidden /> Thinking…
          </span>
        ) : latestReply ? (
          latestReply
        ) : (
          <span className="text-[var(--muted)]">
            Ask anything about your problem. I ask questions back — I never write your code.
          </span>
        )}
      </div>

      <div className="shrink-0 px-3 pt-3">
        <p className="mb-2 text-[10.5px] font-medium tracking-wide text-[var(--faint)] uppercase">Try saying</p>
        <div className="no-scrollbar -mx-3 flex gap-1.5 overflow-x-auto px-3">
          {chips.map((c) => (
            <button key={c} className="chip shrink-0 whitespace-nowrap" onClick={() => send(c)} disabled={busy || done}>
              <CornerDownRight size={11} className="text-[var(--faint)]" aria-hidden />
              {c}
            </button>
          ))}
        </div>
      </div>

      {attachOpen && (
        <div className="mx-3 mt-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--background)] p-2 text-[11px]">
          <p className="mb-1.5 flex items-center gap-1.5 font-medium">
            <Paperclip size={11} aria-hidden /> Attached to your next message
          </p>
          {(["code", "run", "observation"] as const).map((k) => (
            <label key={k} className="flex items-center gap-2 py-0.5 text-[var(--muted)]">
              <input
                type="checkbox"
                className="switch"
                checked={attach[k]}
                onChange={(e) => setAttach((a) => ({ ...a, [k]: e.target.checked }))}
              />
              {k === "code" ? "Current code" : k === "run" ? "Last run output" : "Latest screen observation"}
            </label>
          ))}
          {attachedContext.length ? (
            <pre className="scroll-thin mt-2 max-h-24 overflow-y-auto rounded bg-[var(--surface-2)] p-2 whitespace-pre-wrap font-mono text-[10px] text-[var(--muted)]">
              {attachedContext.map((p) => `[${p.label}]\n${p.body}`).join("\n\n")}
            </pre>
          ) : (
            <p className="mt-1 text-[var(--faint)]">Nothing to attach yet.</p>
          )}
        </div>
      )}

      {/* composer, Cursor-chat style: input on top, actions underneath */}
      <form
        className="mx-3 mt-3 shrink-0 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-2)] transition-colors focus-within:border-[var(--border-strong)]"
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
          placeholder={done ? "Solved — reset to try again" : "Ask the tutor…"}
          className="w-full bg-transparent px-3 pt-2.5 pb-1 text-[13px] outline-none placeholder:text-[var(--faint)] disabled:opacity-50"
        />
        <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
          <button
            type="button"
            className="icon-btn"
            aria-label="Attach context to the next message"
            aria-pressed={attachOpen}
            title="Attach code, run output or what is on screen"
            onClick={() => setAttachOpen((o) => !o)}
          >
            <Plus size={15} />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label={listening ? "Stop listening" : "Speak your question"}
            aria-pressed={listening}
            onClick={toggleMic}
            disabled={!voiceEnabled || !recognitionCtor() || busy}
            title={voiceEnabled ? (listening ? "Stop" : "Speak") : "Turn on voice input below first"}
          >
            {listening ? <MicOff size={15} /> : <Mic size={15} />}
          </button>
          <span className="ml-1 text-[10px] text-[var(--faint)]">
            <span className="kbd">Enter</span> to send
          </span>
          <button
            type="submit"
            disabled={!canSend}
            aria-label="Send"
            className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded-full bg-[var(--primary)] text-[var(--on-primary)] transition-opacity disabled:opacity-25"
          >
            <ArrowUp size={15} strokeWidth={2.4} />
          </button>
        </div>
      </form>

      <div className="mt-3 shrink-0 space-y-1.5 border-t border-[var(--border)] bg-[var(--chrome)] px-3 py-2.5 text-[10.5px] text-[var(--muted)]">
        <label className="flex items-center gap-2">
          <input type="checkbox" className="switch" checked={voiceEnabled} onChange={(e) => setVoiceEnabled(e.target.checked)} />
          <Mic size={11} aria-hidden />
          Voice input <span className="text-[var(--faint)]">— Chrome sends your audio to Google</span>
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" className="switch" checked={readAloud} onChange={(e) => setReadAloud(e.target.checked)} />
          <Volume2 size={11} aria-hidden />
          Read replies aloud <span className="text-[var(--faint)]">— your browser&apos;s voice, on device</span>
        </label>
        <p className="flex min-w-0 items-center gap-1.5 pt-0.5 text-[var(--faint)]">
          <Activity size={11} className="shrink-0" aria-hidden />
          <span className="shrink-0">Diagnosis</span>
          <span className="min-w-0 truncate font-mono" title={view?.diagnosis?.ranker ?? view?.temporal?.ranker ?? "rules-v1"}>
            {view?.diagnosis?.ranker ?? view?.temporal?.ranker ?? "rules-v1"}
          </span>
          <span className="shrink-0">· advisory</span>
        </p>
      </div>
    </div>
  );

  if (pipWindow) return createPortal(panel, pipWindow.document.body);

  return (
    <div className="fixed right-4 bottom-12 z-50 w-[360px] overflow-hidden rounded-[var(--radius-lg)] shadow-[var(--shadow-pop)]">
      {panel}
    </div>
  );
}

const ORB_LABEL: Record<OrbState, string> = {
  idle: "Watching your screen",
  listening: "Listening…",
  thinking: "Thinking…",
  speaking: "Speaking",
  muted: "Ready",
};

/** The assistant's presence: a Siri-style glass orb, animated in CSS (globals.css). */
export function SiriOrb({ state, size = 120 }: { state: OrbState; size?: number }) {
  return (
    <div
      className={`siri siri-${state}`}
      style={{ "--size": `${size}px` } as React.CSSProperties}
      role="img"
      aria-label={`assistant ${state}`}
    >
      <div className="siri-halo" />
      <div className="siri-sphere">
        <span className="siri-ribbon siri-r1" />
        <span className="siri-ribbon siri-r2" />
        <span className="siri-ribbon siri-r3" />
        <span className="siri-ribbon siri-r4" />
        <span className="siri-swirl" />
        <span className="siri-core" />
      </div>
      <div className="siri-glass" />
    </div>
  );
}
