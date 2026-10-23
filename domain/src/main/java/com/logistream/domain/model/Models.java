package com.logistream.domain.model;

import java.math.BigDecimal;
import java.util.List;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.JsonNode;

/**
 * Wire and row types for the domain service (CLAUDE.md section 5.4).
 *
 * <p>Kept in one file on purpose: they are all small, they only exist to pin
 * down the contract, and one file is easier to diff against section 5.4 than
 * a dozen.
 */
public final class Models {

    private Models() {
    }

    // ---------------------------------------------------------------- rows

    /** One row of app.problems. Not returned to anyone as-is. */
    public record ProblemRow(
            String id,
            String title,
            String description,
            JsonNode examples,
            String starterCode,
            String harnessPython,
            JsonNode rubric,
            int rubricVersion,
            BigDecimal cpuTimeLimit,
            BigDecimal wallTimeLimit,
            int memoryLimitKb,
            String kind,
            String ownerId,
            String language,
            String constraintsText,
            String source,
            String sourceSite,
            JsonNode insights) {

        public boolean isCustom() {
            return KIND_CUSTOM.equals(kind);
        }

        /** Curated problems are public; a custom one is visible to its owner only. */
        public boolean visibleTo(String userId) {
            return !isCustom() || (ownerId != null && ownerId.equals(userId));
        }
    }

    public static final String KIND_CURATED = "curated";
    public static final String KIND_CUSTOM = "custom";

    /** One row of app.hidden_tests. */
    public record TestRow(
            int idx,
            String label,
            boolean isPublic,
            String stdin,
            String expectedOutput) {
    }

    // ------------------------------------------------------------ public API

    /**
     * GET /problems/{id}. Deliberately has no rubric and no tests: this is the
     * only problem payload the browser ever sees.
     */
    public record ProblemView(
            String id,
            String title,
            String description,
            JsonNode examples,
            String starter_code,
            String language,
            String kind,
            String constraints,
            int test_count,
            String source,
            String source_site,
            JsonNode insights,
            int snapshot_count) {
    }

    /** One entry of GET /internal/problems: enough to render a picker. */
    public record ProblemSummary(
            String id,
            String title,
            String kind,
            String language,
            String created_at) {
    }

    // ------------------------------------------------- bring your own problem

    /** One example as the student typed it; explanation is optional. */
    public record ExampleInput(String input, String output, String explanation) {
    }

    /** One student-supplied test: stdin in, expected stdout out. */
    public record TestInput(String label, String input, String expected_output) {
    }

    /**
     * POST /internal/problems. The owner is never in the body: it comes from the
     * X-User-Id header the gateway sets, so a client cannot create a problem for
     * someone else.
     */
    public record CreateProblemRequest(
            String title,
            String statement,
            String constraints,
            List<ExampleInput> examples,
            String starter_code,
            String language,
            List<TestInput> tests,
            String source,
            String source_site,
            JsonNode insights) {
    }

    /** POST /internal/problems/{id}/snapshots: code the agent saw on screen. */
    public record SnapshotRequest(String code, String language) {
    }

    // ----------------------------------------------------------- internal API

    /** GET /internal/problems/{id}/context. Python only. */
    public record ProblemContext(
            String id,
            String title,
            String description,
            JsonNode rubric,
            int rubric_version,
            String starter_code,
            String kind,
            String constraints,
            JsonNode examples,
            String language,
            String source,
            JsonNode insights) {
    }

    /** POST /internal/execute request. */
    public record ExecuteRequest(
            String problem_id,
            String language,
            String source) {
    }

    /**
     * One test's outcome. Java returns full detail including hidden stdin and
     * expected output; Python strips those before anything reaches SessionView.
     */
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record TestResult(
            int index,
            String label,
            boolean is_public,
            Integer status_id,
            String status_description,
            boolean passed,
            String time,
            String stdin,
            String expected,
            String stdout,
            String stderr) {
    }

    /** POST /internal/execute response. */
    public record ExecuteResponse(
            String bucket,
            int passed,
            int total,
            boolean infra_retry_used,
            List<TestResult> tests) {
    }
}
