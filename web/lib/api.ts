// The browser talks to the gateway and to nothing else (CLAUDE.md section 5.1).
//
// Note what is never sent: thread_id. The gateway derives it from the user and
// the problem, and ignores any the client supplies. Sending one from here would
// be pointless as well as wrong.

import type { NewProblem, Problem, ProblemSummary, SessionView } from "./types";

const GATEWAY =
  process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8000";

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
};

export { GATEWAY };
