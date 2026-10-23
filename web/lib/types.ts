// Mirrors the SessionView contract (CLAUDE.md section 5.2).
//
// The gateway passes this through from Python unchanged, so these types are the
// contract. Note what is deliberately absent from LastEval: the evaluator's
// free-text `rationale` is logged server-side and never sent here.

export type Phase = "LOGIC" | "CODE" | "DONE";

export type Status =
  | "LOGIC_WRITE"
  | "LOGIC_CHAT"
  | "CODE_WRITE"
  | "CODE_CHAT"
  | "SUCCESS";

export type Bucket =
  | "ACCEPTED"
  | "WRONG_ANSWER"
  | "TLE"
  | "COMPILE_ERROR"
  | "RUNTIME_ERROR"
  | "INFRA_ERROR"
  // bring-your-own-problem with no tests: it ran, nothing was compared
  | "NO_TESTS";

export type ProblemKind = "curated" | "custom";

export interface Message {
  role: "student" | "tutor" | "system";
  kind: "logic" | "chat" | "code" | "hint" | "result" | "info";
  text: string;
  ts: string;
}

export interface LastEval {
  verdict: "PASS" | "FAIL" | "FLAGGED";
  matched_approach: string | null;
  missing_steps: string[];
  violated_invariants: string[];
  misconception_id: string | null;
  confidence: number;
  cache_hit: boolean;
}

export interface TestResult {
  index: number;
  label: string;
  is_public: boolean;
  passed: boolean;
  status: string | null;
  time: string | null;
  stderr_excerpt: string;
  // present only when is_public - hidden tests are stripped server-side
  stdin?: string;
  expected?: string;
  stdout?: string;
}

export interface LastExecution {
  bucket: Bucket;
  passed: number;
  total: number;
  tests: TestResult[];
}

export interface DebugInfo {
  trace_id: string | null;
  last_node_path: string[];
  regenerations: number;
  verifier_rejections: { reason: string }[];
  fallback_used: boolean;
  run_history?: RunRecord[];
}

/** One compact temporal-memory record per run (no test data, no code). */
export interface RunRecord {
  ts: string;
  bucket: Bucket;
  passed: number;
  total: number;
  code_sha: string;
  top_cause: string | null;
  verified: boolean;
}

/** Rules-baseline diagnosis. Scores order candidates; they are not probabilities. */
export interface DiagnosisCandidate {
  id: string;
  cause: string;
  next_action: string;
  score: number;
  evidence: string[];
  /** Rust booster margin (shadow or promoted); ordering only, not a probability */
  model_score?: number;
}

export interface Diagnosis {
  ranker: string;
  score_kind: string;
  bucket: Bucket;
  candidates: DiagnosisCandidate[];
  model_version?: string | null;
  iterations?: number | null;
}

export interface SessionView {
  thread_id: string;
  problem_id: string;
  phase: Phase;
  status: Status;
  attempts: { logic: number; code: number };
  accepted_logic: string | null;
  messages: Message[];
  last_eval: LastEval | null;
  last_execution: LastExecution | null;
  debug: DebugInfo;
  // additive (bring-your-own-problem); absent from older servers
  problem_kind?: ProblemKind;
  diagnosis?: Diagnosis | null;
  temporal?: TemporalView | null;
}

/** One compact event in the session's temporal memory. Never a screenshot. */
export interface TemporalEvent {
  ts: string;
  kind: "run" | "observation" | "chat" | "edit";
  text: string;
  code_revision: number;
  source: "sandbox" | "screen" | "student";
  /** a screen observation older than the latest run: shown as "seen earlier" */
  stale?: boolean;
}

export interface StudentState {
  label: "progressing" | "stuck" | "thrashing" | "idle";
  scores: Record<string, number>;
  model_version: string;
}

export interface TemporalView {
  summary: string;
  code_revision: number;
  latest_observation_ts: string | null;
  events: TemporalEvent[];
  hypotheses: string[];
  next_action: string | null;
  /** which ranker produced the diagnosis: rules-v1 or the Rust sidecar */
  ranker: string;
  student_state: StudentState | null;
  /** a different problem the observer read off the screen; offered, never auto-applied */
  screen_problem?: ScreenProblem | null;
}

/** Text the local vision model read from the student's screen. Untrusted data. */
export interface ScreenProblem {
  title: string;
  statement: string;
  ts: string;
}

export interface ObserverStatus {
  available: boolean;
  model: string;
  model_present: boolean;
  ollama_version: string | null;
  detail: string;
}

export interface ProblemExample {
  input: string;
  output: string;
  explanation: string;
}

export interface Problem {
  id: string;
  title: string;
  description: string;
  examples: ProblemExample[];
  starter_code: string;
  language: string;
  kind?: ProblemKind;
  constraints?: string;
  test_count?: number;
}

export interface ProblemSummary {
  id: string;
  title: string;
  kind: ProblemKind;
  language: string;
  created_at: string;
}

/** POST /api/problems. Java validates; these limits mirror it for early feedback. */
export interface NewProblem {
  title?: string;
  statement: string;
  constraints?: string;
  examples?: { input: string; output: string; explanation?: string }[];
  starter_code?: string;
  language: string;
  tests?: { label?: string; input: string; expected_output: string }[];
}
