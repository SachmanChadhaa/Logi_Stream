package com.logistream.domain.exec;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import com.logistream.domain.exec.BucketMapper.Scored;
import com.logistream.domain.exec.Sandbox.Result;

/**
 * The section 8 bucket table, exercised without spending Judge0 quota.
 * These are the rules the whole code-phase demo path depends on.
 */
class BucketMapperTest {

    private static Result r(int statusId, String stdout, String stderr) {
        return new Result("tok", statusId, "desc", stdout, stderr, "", "0.01");
    }

    private static Scored ok(String stdout, String expected) {
        Result res = r(3, stdout, "");
        return new Scored(res, BucketMapper.outputMatches(stdout, expected));
    }

    private static Scored bad(int statusId, String stderr) {
        return new Scored(r(statusId, "", stderr), false);
    }

    @Test
    @DisplayName("all status 3 and every stdout matches -> ACCEPTED")
    void accepted() {
        assertEquals(BucketMapper.ACCEPTED,
                BucketMapper.bucketOf(List.of(ok("[0, 1]", "[0, 1]"), ok("[1, 2]", "[1, 2]")), false));
    }

    @Test
    @DisplayName("status 3 with a stdout mismatch -> WRONG_ANSWER")
    void wrongAnswerFromMismatch() {
        assertEquals(BucketMapper.WRONG_ANSWER,
                BucketMapper.bucketOf(List.of(ok("[0, 1]", "[0, 1]"), ok("[2, 7]", "[0, 1]")), false));
    }

    @Test
    @DisplayName("judge0 status 4 -> WRONG_ANSWER")
    void wrongAnswerFromStatus4() {
        assertEquals(BucketMapper.WRONG_ANSWER,
                BucketMapper.bucketOf(List.of(ok("[0, 1]", "[0, 1]"), bad(4, "")), false));
    }

    @Test
    @DisplayName("status 5 -> TLE")
    void tle() {
        assertEquals(BucketMapper.TLE,
                BucketMapper.bucketOf(List.of(ok("[0, 1]", "[0, 1]"), bad(5, "")), false));
    }

    @Test
    @DisplayName("status 6 -> COMPILE_ERROR")
    void compileError() {
        assertEquals(BucketMapper.COMPILE_ERROR,
                BucketMapper.bucketOf(List.of(bad(6, "boom")), false));
    }

    @Test
    @DisplayName("trap 2: python SyntaxError arrives as status 11 and must become COMPILE_ERROR")
    void pythonSyntaxErrorIsCompileError() {
        Scored s = bad(11, "  File \"script.py\", line 1\n    def two_sum(nums, target)\n"
                + "                             ^\nSyntaxError: expected ':'");
        assertEquals(BucketMapper.COMPILE_ERROR, BucketMapper.bucketOf(List.of(s), false));
        assertTrue(BucketMapper.looksLikePythonSyntaxError(s.result()));
    }

    @Test
    @DisplayName("IndentationError also counts as a compile error")
    void indentationErrorIsCompileError() {
        Scored s = bad(11, "IndentationError: unexpected indent");
        assertEquals(BucketMapper.COMPILE_ERROR, BucketMapper.bucketOf(List.of(s), false));
    }

    @Test
    @DisplayName("a plain NZEC (KeyError) stays RUNTIME_ERROR")
    void keyErrorIsRuntimeError() {
        Scored s = bad(11, "Traceback (most recent call last):\n  KeyError: 7");
        assertFalse(BucketMapper.looksLikePythonSyntaxError(s.result()));
        assertEquals(BucketMapper.RUNTIME_ERROR, BucketMapper.bucketOf(List.of(s), false));
    }

    @Test
    @DisplayName("status 13/14 -> INFRA_ERROR, and it outranks everything else")
    void infraErrorWins() {
        assertEquals(BucketMapper.INFRA_ERROR,
                BucketMapper.bucketOf(List.of(bad(13, ""), bad(6, ""), bad(5, "")), false));
        assertEquals(BucketMapper.INFRA_ERROR, BucketMapper.bucketOf(List.of(bad(14, "")), false));
    }

    @Test
    @DisplayName("still queued after the poll budget -> INFRA_ERROR")
    void timedOutIsInfraError() {
        assertEquals(BucketMapper.INFRA_ERROR,
                BucketMapper.bucketOf(List.of(ok("[0, 1]", "[0, 1]")), true));
        assertEquals(BucketMapper.INFRA_ERROR,
                BucketMapper.bucketOf(List.of(new Scored(r(2, "", ""), false)), false));
    }

    @Test
    @DisplayName("compile error outranks runtime error, which outranks TLE, which outranks wrong answer")
    void priorityOrder() {
        Scored wrong = new Scored(r(4, "", ""), false);
        Scored tle = bad(5, "");
        Scored runtime = bad(11, "KeyError");
        Scored compile = bad(6, "");

        assertEquals(BucketMapper.WRONG_ANSWER, BucketMapper.bucketOf(List.of(wrong), false));
        assertEquals(BucketMapper.TLE, BucketMapper.bucketOf(List.of(wrong, tle), false));
        assertEquals(BucketMapper.RUNTIME_ERROR, BucketMapper.bucketOf(List.of(wrong, tle, runtime), false));
        assertEquals(BucketMapper.COMPILE_ERROR,
                BucketMapper.bucketOf(List.of(wrong, tle, runtime, compile), false));
    }

    @Test
    @DisplayName("stdout comparison ignores surrounding whitespace only")
    void outputComparison() {
        assertTrue(BucketMapper.outputMatches("[0, 1]\n", "[0, 1]"));
        assertTrue(BucketMapper.outputMatches("  [0, 1]  ", "[0, 1]"));
        assertFalse(BucketMapper.outputMatches("[0,1]", "[0, 1]"));   // harness emits ", "
        assertFalse(BucketMapper.outputMatches("[1, 0]", "[0, 1]"));  // harness sorts
        assertFalse(BucketMapper.outputMatches(null, "[0, 1]"));
        assertTrue(BucketMapper.outputMatches(null, ""));
    }

    @Test
    @DisplayName("an empty batch is an infra problem, never a pass")
    void emptyBatch() {
        assertEquals(BucketMapper.INFRA_ERROR, BucketMapper.bucketOf(List.of(), false));
    }

    // ------------------------------------------------ bring your own problem

    @Test
    @DisplayName("no tests: a clean run is NO_TESTS, never ACCEPTED")
    void noTestsCleanRunIsNotAccepted() {
        assertEquals(BucketMapper.NO_TESTS,
                BucketMapper.bucketOfUnverified(r(3, "hello", ""), false));
    }

    @Test
    @DisplayName("no tests: errors still map exactly as with tests")
    void noTestsErrorsStillMap() {
        assertEquals(BucketMapper.COMPILE_ERROR, BucketMapper.bucketOfUnverified(
                r(11, "", "SyntaxError: invalid syntax"), false));
        assertEquals(BucketMapper.RUNTIME_ERROR, BucketMapper.bucketOfUnverified(
                r(11, "", "ZeroDivisionError: division by zero"), false));
        assertEquals(BucketMapper.TLE, BucketMapper.bucketOfUnverified(r(5, "", ""), false));
        assertEquals(BucketMapper.INFRA_ERROR, BucketMapper.bucketOfUnverified(r(13, "", ""), false));
    }
}
