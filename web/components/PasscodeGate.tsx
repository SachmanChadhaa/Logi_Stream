"use client";

import { useEffect, useState } from "react";

import { ApiError, PASSCODE_EVENT, api, passcode } from "@/lib/api";

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
    <div className="flex h-screen items-center justify-center bg-[var(--background)] px-4">
      <div className="w-full max-w-sm rounded border border-[var(--border)] bg-[var(--surface)] p-6">
        <h1 className="font-serif text-xl font-semibold">LogiStream</h1>
        {state === "checking" && (
          <p className="mt-3 text-sm text-[var(--muted)]">Connecting…</p>
        )}
        {state === "down" && (
          <>
            <p className="mt-3 text-sm text-[var(--fail)]">{error}</p>
            <p className="mt-2 text-xs text-[var(--muted)]">
              The backend runs on the presenter&apos;s laptop. If it is asleep or
              the tunnel is down, this demo cannot work.
            </p>
            <button
              onClick={() => {
                setState("checking");
                check();
              }}
              className="mt-4 rounded bg-[var(--accent)] px-4 py-2 text-sm text-[var(--on-accent)]"
            >
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
            <label htmlFor="passcode" className="text-sm">
              Demo passcode
            </label>
            <input
              id="passcode"
              type="password"
              autoComplete="off"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              disabled={busy}
              className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--background)] p-2 text-sm outline-none focus:border-[var(--accent)]"
            />
            {error && <p role="alert" className="mt-2 text-xs text-[var(--fail)]">{error}</p>}
            <button
              type="submit"
              disabled={busy || !value.trim()}
              className="mt-4 w-full rounded bg-[var(--accent)] px-4 py-2 text-sm text-[var(--on-accent)] disabled:opacity-40"
            >
              {busy ? "Checking…" : "Enter"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
