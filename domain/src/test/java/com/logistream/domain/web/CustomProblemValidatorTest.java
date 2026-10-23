package com.logistream.domain.web;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

import java.util.Collections;
import java.util.List;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import com.logistream.domain.model.Models.CreateProblemRequest;
import com.logistream.domain.model.Models.ExampleInput;
import com.logistream.domain.model.Models.TestInput;

/** The bring-your-own-problem boundary rules, without a database. */
class CustomProblemValidatorTest {

    private static CreateProblemRequest req(String statement, String language, List<TestInput> tests) {
        return new CreateProblemRequest(null, statement, null, null, null, language, tests);
    }

    @Test
    @DisplayName("a statement alone is a valid problem")
    void minimal() {
        assertNull(CustomProblemValidator.validate(req("Reverse a string.", null, null)));
    }

    @Test
    @DisplayName("missing or blank statement is rejected")
    void statementRequired() {
        assertEquals("statement", CustomProblemValidator.validate(req(null, null, null)).field());
        assertEquals("statement", CustomProblemValidator.validate(req("   ", null, null)).field());
        assertEquals("body", CustomProblemValidator.validate(null).field());
    }

    @Test
    @DisplayName("over-long statement is rejected")
    void statementTooLong() {
        String big = "x".repeat(CustomProblemValidator.MAX_STATEMENT + 1);
        assertEquals("statement", CustomProblemValidator.validate(req(big, null, null)).field());
    }

    @Test
    @DisplayName("only supported languages are accepted")
    void language() {
        assertNull(CustomProblemValidator.validate(req("p", "python", null)));
        assertEquals("language", CustomProblemValidator.validate(req("p", "cobol", null)).field());
    }

    @Test
    @DisplayName("a test needs an expected output, but it may be empty")
    void testsNeedExpected() {
        assertNotNull(CustomProblemValidator.validate(
                req("p", null, List.of(new TestInput("t", "1", null)))));
        assertNull(CustomProblemValidator.validate(
                req("p", null, List.of(new TestInput("t", "1", "")))));
    }

    @Test
    @DisplayName("too many tests or examples is rejected")
    void counts() {
        List<TestInput> tests = Collections.nCopies(CustomProblemValidator.MAX_TESTS + 1,
                new TestInput("t", "1", "1"));
        assertEquals("tests", CustomProblemValidator.validate(req("p", null, tests)).field());

        List<ExampleInput> ex = Collections.nCopies(CustomProblemValidator.MAX_EXAMPLES + 1,
                new ExampleInput("1", "1", ""));
        assertEquals("examples", CustomProblemValidator.validate(
                new CreateProblemRequest(null, "p", null, ex, null, null, null)).field());
    }

    @Test
    @DisplayName("title falls back to the statement's first line, trimmed")
    void titleFallback() {
        assertEquals("Count vowels",
                CustomProblemValidator.titleFor(req("## Count vowels\nGiven a string...", null, null)));
        assertEquals("Mine", CustomProblemValidator.titleFor(
                new CreateProblemRequest("  Mine ", "s", null, null, null, null, null)));
        String longLine = "a".repeat(100);
        assertEquals(60, CustomProblemValidator.titleFor(req(longLine, null, null)).length());
    }
}
