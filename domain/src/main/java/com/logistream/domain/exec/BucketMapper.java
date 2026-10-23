package com.logistream.domain.exec;

import java.util.List;

import com.logistream.domain.exec.Sandbox.Result;

/**
 * Maps a batch of Judge0 results to one bucket (CLAUDE.md section 8).
 *
 * <p>Worst wins, in the table's order. Pure and static so it can be unit-tested
 * without spending a single Judge0 request.
 */
public final class BucketMapper {

    private BucketMapper() {
    }

    public static final String ACCEPTED = "ACCEPTED";
    public static final String WRONG_ANSWER = "WRONG_ANSWER";
    public static final String TLE = "TLE";
    public static final String COMPILE_ERROR = "COMPILE_ERROR";
    public static final String RUNTIME_ERROR = "RUNTIME_ERROR";
    public static final String INFRA_ERROR = "INFRA_ERROR";
    /**
     * Bring-your-own-problem with no tests: the program ran to completion, but
     * there was nothing to compare its output against. Deliberately NOT
     * ACCEPTED -- "it ran" is not "it is correct", and the tutor and UI say so.
     */
    public static final String NO_TESTS = "NO_TESTS";

    /** One test's result paired with whether its stdout matched. */
    public record Scored(Result result, boolean outputMatched) {
    }

    /**
     * Python has no compile step, so Judge0 reports a SyntaxError as status 11
     * (Runtime Error / NZEC) rather than status 6. Without this reclassification
     * the "syntax error" path in the demo never fires (CLAUDE.md trap 2).
     */
    public static boolean looksLikePythonSyntaxError(Result r) {
        if (r.statusId() < 7 || r.statusId() > 12) {
            return false;
        }
        String err = r.combinedError();
        return err.contains("SyntaxError") || err.contains("IndentationError");
    }

    /**
     * @param scored  every test in the batch, with its stdout comparison already done
     * @param timedOut true if submissions were still in status 1/2 after maxPolls
     */
    public static String bucketOf(List<Scored> scored, boolean timedOut) {
        if (scored.isEmpty()) {
            return INFRA_ERROR;
        }
        // still queued after the poll budget is an infra problem, not the student's
        if (timedOut || scored.stream().anyMatch(s -> s.result().pending())) {
            return INFRA_ERROR;
        }

        List<Result> rs = scored.stream().map(Scored::result).toList();

        // 1. internal error / exec format error (the caller has already retried once)
        if (rs.stream().anyMatch(r -> r.statusId() == 13 || r.statusId() == 14)) {
            return INFRA_ERROR;
        }
        // 2. python-specific: NZEC that is really a syntax error -- before rule 4
        if (rs.stream().anyMatch(BucketMapper::looksLikePythonSyntaxError)) {
            return COMPILE_ERROR;
        }
        // 3. a real compilation error
        if (rs.stream().anyMatch(r -> r.statusId() == 6)) {
            return COMPILE_ERROR;
        }
        // 4. runtime errors
        if (rs.stream().anyMatch(r -> r.statusId() >= 7 && r.statusId() <= 12)) {
            return RUNTIME_ERROR;
        }
        // 5. time limit exceeded
        if (rs.stream().anyMatch(r -> r.statusId() == 5)) {
            return TLE;
        }
        // 6. judge0 said wrong answer, or it said accepted but our own comparison disagrees
        if (scored.stream().anyMatch(s -> s.result().statusId() == 4
                || (s.result().statusId() == 3 && !s.outputMatched()))) {
            return WRONG_ANSWER;
        }
        // 7. everything ran and every stdout matched
        if (scored.stream().allMatch(s -> s.result().statusId() == 3 && s.outputMatched())) {
            return ACCEPTED;
        }
        // an unmapped status id: treat as infra rather than silently passing
        return INFRA_ERROR;
    }

    /**
     * Bucket for a smoke run of a problem that has no tests. Errors map exactly
     * as they would with tests; a clean run becomes NO_TESTS instead of ACCEPTED.
     */
    public static String bucketOfUnverified(Result smokeRun, boolean timedOut) {
        String b = bucketOf(List.of(new Scored(smokeRun, true)), timedOut);
        return ACCEPTED.equals(b) ? NO_TESTS : b;
    }

    /**
     * Per-test status text. The sandbox reports "Accepted" for any clean exit;
     * status 3 with mismatched output is a Wrong Answer (section 8), so say so
     * instead of showing (and prompting the tutor with) "Accepted" on a failure.
     */
    public static String displayStatus(Result r, boolean matched) {
        return r.statusId() == 3 && !matched ? "Wrong Answer" : r.statusDescription();
    }

    /** Java compares stdout itself; Judge0 never sees expected_output (section 8). */
    public static boolean outputMatches(String stdout, String expected) {
        return normalise(stdout).equals(normalise(expected));
    }

    private static String normalise(String s) {
        return s == null ? "" : s.strip();
    }
}
