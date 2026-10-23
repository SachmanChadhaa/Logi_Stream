"use client";

import { useEffect, useState } from "react";

import { ArrowRight, KeyRound, Loader2, RotateCw, WifiOff } from "lucide-react";

import { ApiError, PASSCODE_EVENT, api, passcode } from "@/lib/api";
import { Logo } from "./Header";

/**
 * Public-demo access control, browser side. The gateway enforces the passcode
 * on every /api call (DEMO_PASSCODE); this only asks for it, keeps it in
 * sessionStorage for this tab, and asks again if the gateway ever rejects it.
 * Locally, with no DEMO_PASSCODE set, the check passes and nothing is shown.
 */
export function PasscodeGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<"checking" | "need" | "ok" | "down">("checking");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const check = async () => {
    try {
      await api.authCheck();
      setState("ok");
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setState("need");
      } else {
        setState("down");
        setError(e instanceof ApiError ? e.message : String(e));
      }
    }
  };

  useEffect(() => {
    check();
    const onNeed = () => setState("need");
    window.addEventListener(PASSCODE_EVENT, onNeed);
    return () => window.removeEventListener(PASSCODE_EVENT, onNeed);
  }, []);

  const submit = async () => {
    if (!value.trim()) return;
    setBusy(true);
    passcode.set(value.trim());
    try {
      await api.authCheck();
      setState("ok");
      setError(null);
    } catch (e) {
      passcode.set(null);
      setError(e instanceof ApiError && e.status === 401 ? "That passcode is not right." : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (state === "ok") return <>{children}</>;

  return (
    <div className="flex h-screen items-center justify-center bg-[var(--chrome)] px-4">
      <div className="panel w-full max-w-sm p-6 shadow-[var(--shadow-pop)]">
        <h1 className="flex items-center gap-2 text-[17px] font-semibold">
          <Logo /> LogiStream
        </h1>
        {state === "checking" && (
          <p className="mt-4 flex items-center gap-2 text-[13px] text-[var(--muted)]">
            <Loader2 size={13} className="animate-spin" aria-hidden /> Connecting…
          </p>
        )}
        {state === "down" && (
          <>
            <p className="mt-4 flex items-start gap-2 text-[13px] text-[var(--fail)]">
              <WifiOff size={14} className="mt-0.5 shrink-0" aria-hidden />
              {error}
            </p>
            <p className="mt-2 text-xs text-[var(--muted)]">
              The backend runs on the presenter&apos;s laptop. If it is asleep or
              the tunnel is down, this demo cannot work.
            </p>
            <button
              onClick={() => {
                setState("checking");
                check();
              }}
              className="btn btn-secondary mt-4"
            >
              <RotateCw size={12} aria-hidden />
              Retry
            </button>
          </>
        )}
        {state === "need" && (
          <form
            className="mt-3"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <label htmlFor="passcode" className="flex items-center gap-1.5 text-[12.5px] font-medium">
              <KeyRound size={12} className="text-[var(--muted)]" aria-hidden />
              Demo passcode
            </label>
            <input
              id="passcode"
              type="password"
              autoComplete="off"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              disabled={busy}
              className="field mt-1.5"
            />
            {error && <p role="alert" className="mt-2 text-xs text-[var(--fail)]">{error}</p>}
            <button
              type="submit"
              disabled={busy || !value.trim()}
              className="btn btn-primary btn-lg mt-4 w-full"
            >
              {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}
              {busy ? "Checking…" : "Enter"}
              {!busy && <ArrowRight size={14} aria-hidden />}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
