package com.logistream.domain.web;

import java.util.List;
import java.util.Set;

import com.logistream.domain.model.Models.CreateProblemRequest;
import com.logistream.domain.model.Models.ExampleInput;
import com.logistream.domain.model.Models.TestInput;

/**
 * Validates a bring-your-own-problem submission (docs/BYOP.md).
 *
 * <p>Java is the boundary that stores the problem, so this is where limits are
 * enforced; the gateway and the UI only pass the request along. Pure and static
 * so every rule is unit-testable without a database.
 *
 * <p>The limits are generous for a real exercise and small enough that one
 * request cannot fill the database or make a tutor prompt absurdly long.
 */
public final class CustomProblemValidator {

    private CustomProblemValidator() {
    }

    public static final Set<String> SUPPORTED_LANGUAGES = Set.of("python");

    public static final int MAX_TITLE = 120;
    public static final int MAX_STATEMENT = 20_000;
    public static final int MAX_CONSTRAINTS = 4_000;
    public static final int MAX_EXAMPLES = 10;
    public static final int MAX_EXAMPLE_FIELD = 2_000;
    public static final int MAX_STARTER_CODE = 50_000;
    public static final int MAX_TESTS = 20;
    public static final int MAX_TEST_LABEL = 80;
    public static final int MAX_TEST_IO = 20_000;
    public static final int MAX_PROBLEMS_PER_USER = 100;
    public static final Set<String> SOURCES = Set.of("form", "screen");
    public static final int MAX_SOURCE_SITE = 200;
    public static final int MAX_INSIGHTS_JSON = 20_000;
    public static final int MAX_SNAPSHOT_CODE = 20_000;

    /** A rule violation: which field, and a sentence a student can act on. */
    public record Violation(String field, String message) {
    }

    /** @return the first violation, or null if the request is acceptable */
    public static Violation validate(CreateProblemRequest req) {
        if (req == null) {
            return new Violation("body", "request body is required");
        }
        if (req.statement() == null || req.statement().isBlank()) {
            return new Violation("statement", "the problem statement is required");
        }
        if (req.statement().length() > MAX_STATEMENT) {
            return tooLong("statement", MAX_STATEMENT);
        }
        if (req.title() != null && req.title().length() > MAX_TITLE) {
            return tooLong("title", MAX_TITLE);
        }
        if (req.constraints() != null && req.constraints().length() > MAX_CONSTRAINTS) {
            return tooLong("constraints", MAX_CONSTRAINTS);
        }
        if (req.starter_code() != null && req.starter_code().length() > MAX_STARTER_CODE) {
            return tooLong("starter_code", MAX_STARTER_CODE);
        }

        String language = req.language() == null ? "python" : req.language();
        if (!SUPPORTED_LANGUAGES.contains(language)) {
            return new Violation("language",
                    "unsupported language '" + language + "'; supported: " + SUPPORTED_LANGUAGES);
        }

        List<ExampleInput> examples = req.examples() == null ? List.of() : req.examples();
        if (examples.size() > MAX_EXAMPLES) {
            return new Violation("examples", "at most " + MAX_EXAMPLES + " examples");
        }
        for (int i = 0; i < examples.size(); i++) {
            ExampleInput e = examples.get(i);
            if (e == null) {
                return new Violation("examples[" + i + "]", "example must not be null");
            }
            if (len(e.input()) > MAX_EXAMPLE_FIELD || len(e.output()) > MAX_EXAMPLE_FIELD
                    || len(e.explanation()) > MAX_EXAMPLE_FIELD) {
                return tooLong("examples[" + i + "]", MAX_EXAMPLE_FIELD);
            }
        }

        List<TestInput> tests = req.tests() == null ? List.of() : req.tests();
        if (tests.size() > MAX_TESTS) {
            return new Violation("tests", "at most " + MAX_TESTS + " tests");
        }
        for (int i = 0; i < tests.size(); i++) {
            TestInput t = tests.get(i);
            String field = "tests[" + i + "]";
            if (t == null) {
                return new Violation(field, "test must not be null");
            }
            if (t.expected_output() == null) {
                // an empty expected output is legal; a missing one is a mistake
                return new Violation(field + ".expected_output", "expected output is required");
            }
            if (len(t.label()) > MAX_TEST_LABEL) {
                return tooLong(field + ".label", MAX_TEST_LABEL);
            }
            if (len(t.input()) > MAX_TEST_IO || len(t.expected_output()) > MAX_TEST_IO) {
                return tooLong(field, MAX_TEST_IO);
            }
        }
        if (req.source() != null && !req.source().isBlank() && !SOURCES.contains(req.source())) {
            return new Violation("source", "source must be one of " + SOURCES);
        }
        if (len(req.source_site()) > MAX_SOURCE_SITE) {
            return tooLong("source_site", MAX_SOURCE_SITE);
        }
        if (req.insights() != null && !req.insights().isNull()) {
            if (!req.insights().isObject()) {
                return new Violation("insights", "insights must be a JSON object");
            }
            if (req.insights().toString().length() > MAX_INSIGHTS_JSON) {
                return tooLong("insights", MAX_INSIGHTS_JSON);
            }
        }
        return null;
    }

    /** Title as stored: the student's own, or the statement's first line. */
    public static String titleFor(CreateProblemRequest req) {
        if (req.title() != null && !req.title().isBlank()) {
            return req.title().strip();
        }
        String first = req.statement().strip().lines().findFirst().orElse("Untitled problem").strip();
        first = first.replaceAll("^[#*\\s]+", "");
        if (first.isEmpty()) {
            first = "Untitled problem";
        }
        return first.length() <= 60 ? first : first.substring(0, 57) + "...";
    }

    private static int len(String s) {
        return s == null ? 0 : s.length();
    }

    private static Violation tooLong(String field, int max) {
        return new Violation(field, field + " is too long (max " + max + " characters)");
    }
}
