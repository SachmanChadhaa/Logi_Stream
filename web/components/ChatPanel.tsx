"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUp, Info, MessageSquare, Minus } from "lucide-react";

import type { Message } from "@/lib/types";
import { SiriOrb } from "./Assistant";

/**
 * Floating Socratic chat over the right pane. Opens automatically when a tutor
 * message arrives, because the tutor's question is the product -- if the
 * student has to go looking for it, the whole premise is buried.
 */
export function ChatPanel({
  messages,
  open,
  onOpenChange,
  onSend,
  busy,
  disabled,
  done,
}: {
  messages: Message[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSend: (text: string) => void;
  busy: boolean;
  /** input is unusable right now (busy OR finished) */
  disabled: boolean;
  /** the session is actually over - only this changes the placeholder */
  done: boolean;
}) {
  const [draft, setDraft] = useState("");
  const scroller = useRef<HTMLDivElement>(null);

  const conversation = messages.filter(
    (m) => m.kind === "hint" || m.kind === "chat" || m.kind === "info",
  );

  useEffect(() => {
    if (open && scroller.current) {
      scroller.current.scrollTop = scroller.current.scrollHeight;
    }
  }, [open, conversation.length, busy]);

  const tutorCount = messages.filter((m) => m.role === "tutor").length;

  if (!open) {
    return (
      <button
        onClick={() => onOpenChange(true)}
        className="btn btn-secondary absolute right-4 bottom-4 z-20 !h-8 !rounded-full !px-3 shadow-[var(--shadow-pop)]"
      >
        <MessageSquare size={13} aria-hidden />
        Tutor
        {tutorCount > 0 && (
          <span className="rounded-full bg-[var(--accent)] px-1.5 text-[10px] leading-4 text-[var(--on-accent)]">
            {tutorCount}
          </span>
        )}
      </button>
    );
  }

  const send = () => {
    const text = draft.trim();
    if (!text || busy || disabled) return;
    onSend(text);
    setDraft("");
  };

  return (
    <div className="absolute right-4 bottom-4 z-20 flex h-[28rem] w-[25rem] max-w-[calc(100%-2rem)] flex-col overflow-hidden rounded-[var(--radius-lg)] bg-[var(--surface)] shadow-[var(--shadow-pop)]">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--chrome)] px-3">
        <SiriOrb state={busy ? "thinking" : "idle"} size={16} />
        <span className="text-[12px] font-semibold text-[var(--foreground-strong)]">Socratic tutor</span>
        <span className="truncate text-[10.5px] text-[var(--faint)]">asks questions, never gives the answer</span>
        <button onClick={() => onOpenChange(false)} className="icon-btn ml-auto !h-6 !w-6" aria-label="Minimise tutor panel">
          <Minus size={14} />
        </button>
      </div>

      <div ref={scroller} className="scroll-thin min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {conversation.length === 0 && (
          <p className="text-[12px] text-[var(--muted)]">Submit your logic and the tutor will respond here.</p>
        )}
        {conversation.map((m, i) =>
          m.role === "system" ? (
            <div key={i} className="flex items-start gap-2 rounded-[var(--radius)] border border-[var(--border)] px-2.5 py-1.5 text-[11.5px] leading-relaxed text-[var(--muted)]">
              <Info size={12} className="mt-0.5 shrink-0" aria-hidden />
              <span className="whitespace-pre-wrap">{m.text}</span>
            </div>
          ) : m.role === "student" ? (
            <div key={i} className="flex justify-end">
              <span className="max-w-[88%] rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-3)] px-3 py-2 text-[12.5px] leading-relaxed whitespace-pre-wrap text-[var(--foreground-strong)]">
                {m.text}
              </span>
            </div>
          ) : (
            <div key={i} className="flex items-start gap-2">
              <span className="mt-0.5 shrink-0">
                <SiriOrb state="muted" size={14} />
              </span>
              <span className="min-w-0 flex-1 text-[12.5px] leading-relaxed whitespace-pre-wrap">{m.text}</span>
            </div>
          ),
        )}
        {busy && (
          <div className="flex items-center gap-2 text-[12px] text-[var(--muted)]">
            <SiriOrb state="thinking" size={14} />
            <span>Thinking</span>
            <span className="flex gap-0.5">
              <span className="dot">·</span>
              <span className="dot">·</span>
              <span className="dot">·</span>
            </span>
          </div>
        )}
      </div>

      <form
        className="m-2 mt-0 shrink-0 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-2)] transition-colors focus-within:border-[var(--border-strong)]"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <div className="flex items-center gap-1 py-1 pr-1 pl-3">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={busy || disabled}
            // only `done` may say "finished" -- keying this off `disabled` made a
            // slow turn look like the session had ended
            placeholder={done ? "This session is finished." : "Ask the tutor…"}
            className="min-w-0 flex-1 bg-transparent py-1 text-[12.5px] outline-none placeholder:text-[var(--faint)] disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={busy || disabled || !draft.trim()}
            aria-label="Send"
            className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-[var(--primary)] text-[var(--on-primary)] transition-opacity disabled:opacity-25"
          >
            <ArrowUp size={14} strokeWidth={2.4} />
          </button>
        </div>
      </form>
    </div>
  );
}
