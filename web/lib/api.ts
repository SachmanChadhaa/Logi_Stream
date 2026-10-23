// The browser talks to the gateway and to nothing else (CLAUDE.md section 5.1).
//
// Note what is never sent: thread_id. The gateway derives it from the user and
// the problem, and ignores any the client supplies. Sending one from here would
// be pointless as well as wrong.

import type {
  NewProblem,
  ObserverStatus,
  Problem,
  ProblemSummary,
  SessionView,
} from "./types";

// NEXT_PUBLIC_API_BASE is the deployed setting (the Cloudflare tunnel URL on
// Vercel); NEXT_PUBLIC_GATEWAY_URL is the older local name, still honoured.
// The browser calls the gateway directly: a Vercel server-side proxy would cut
// a 90s tutor turn off at the free tier's function limit.
const GATEWAY = (
  process.env.NEXT_PUBLIC_API_BASE ??
  process.env.NEXT_PUBLIC_GATEWAY_URL ??
  "http://localhost:8000"
).replace(/\/+$/, "");

const PASSCODE_KEY = "logistream.passcode";
const USER_KEY = "logistream.user";

// Storage can throw (private mode, blocked site data); everything here must
// work without it.
function store(kind: "session" | "local") {
  try {
    return kind === "session" ? window.sessionStorage : window.localStorage;
  } catch {
    return null;
  }
}

let memoryPasscode: string | null = null;
let memoryUser: string | null = null;

/** The demo passcode, kept for this browser session only. */
export const passcode = {
  get(): string | null {
    try {
      return store("session")?.getItem(PASSCODE_KEY) ?? memoryPasscode;
    } catch {
      return memoryPasscode;
    }
  },
  set(value: string | null) {
    memoryPasscode = value;
    try {
      if (value) store("session")?.setItem(PASSCODE_KEY, value);
      else store("session")?.removeItem(PASSCODE_KEY);
    } catch {
      /* memory copy is enough */
    }
  },
};

/**
 * A random anonymous identity per browser, sent as X-Demo-User. Auth is still
 * mocked (CLAUDE.md section 3), but on a public demo every visitor must not
 * share one "demo-user" session. The id is unguessable, and the gateway still
 * derives the thread from it -- the browser never chooses a thread_id.
 */
function anonUser(): string {
  if (memoryUser) return memoryUser;
  let id: string | null = null;
  try {
    id = store("local")?.getItem(USER_KEY) ?? null;
  } catch {
    id = null;
  }
  if (!id) {
    id = `anon-${crypto.randomUUID()}`;
    try {
      store("local")?.setItem(USER_KEY, id);
    } catch {
      /* per-tab identity then */
    }
  }
  memoryUser = id;
  return id;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public traceId: string | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${GATEWAY}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-Demo-User": anonUser(),
        ...(passcode.get() ? { "X-Demo-Passcode": passcode.get() as string } : {}),
        ...(init.headers ?? {}),
      },
      // A tutor turn on the free tier has been measured past 90s. The browser
      // must not give up early, so no AbortSignal timeout is set here
      // (CLAUDE.md trap 8).
      cache: "no-store",
    });
  } catch (e) {
    throw new ApiError(
      0,
      `Cannot reach the gateway at ${GATEWAY}. Is it running?`,
    );
  }

  const traceId = res.headers.get("x-trace-id");
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // fall through with the raw text below
  }

  if (!res.ok) {
    const detail =
      (body as { detail?: string } | null)?.detail ??
      text.slice(0, 300) ??
      res.statusText;
    if (res.status === 401 && (body as { code?: string } | null)?.code === "passcode_required") {
      // the PasscodeGate listens for this and asks again
      passcode.set(null);
      window.dispatchEvent(new Event(PASSCODE_EVENT));
    }
    throw new ApiError(res.status, detail, traceId);
  }

  return body as T;
}

export const api = {
  getProblem: (problemId: string) =>
    request<Problem>(`/api/problems/${encodeURIComponent(problemId)}`),

  listProblems: () =>
    request<{ problems: ProblemSummary[] }>("/api/problems"),

  createProblem: (p: NewProblem) =>
    request<Problem>("/api/problems", {
      method: "POST",
      body: JSON.stringify(p),
    }),

  start: (problemId: string) =>
    request<SessionView>("/api/sessions/start", {
      method: "POST",
      body: JSON.stringify({ problem_id: problemId }),
    }),

  event: (problemId: string, type: "logic" | "chat" | "code", text: string) =>
    request<SessionView>("/api/sessions/event", {
      method: "POST",
      body: JSON.stringify({ problem_id: problemId, type, text }),
    }),

  reset: (problemId: string) =>
    request<{ ok: boolean }>("/api/sessions/reset", {
      method: "POST",
      body: JSON.stringify({ problem_id: problemId }),
    }),

  get: (problemId: string) =>
    request<SessionView>(`/api/sessions/${encodeURIComponent(problemId)}`),

  authCheck: () =>
    request<{ ok: boolean; passcode_required: boolean }>("/api/auth/check"),

  observerStatus: () => request<ObserverStatus>("/api/observer/status"),

  /** One downscaled frame -> local VLM. Returns the updated session view. */
  observe: (
    problemId: string,
    imageB64: string,
    trigger: string,
    codeRevision: number,
  ) =>
    request<SessionView>("/api/sessions/observe", {
      method: "POST",
      body: JSON.stringify({
        problem_id: problemId,
        image_b64: imageB64,
        trigger,
        code_revision: codeRevision,
      }),
    }),
};

export const PASSCODE_EVENT = "logistream:passcode-required";

export { GATEWAY };
