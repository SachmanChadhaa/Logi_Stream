package com.logistream.domain.repo;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.logistream.domain.model.Models;
import com.logistream.domain.model.Models.CreateProblemRequest;
import com.logistream.domain.model.Models.ProblemRow;
import com.logistream.domain.model.Models.ProblemSummary;
import com.logistream.domain.model.Models.TestInput;
import com.logistream.domain.model.Models.TestRow;

/**
 * JdbcTemplate, not JPA: CLAUDE.md section 3 swaps Spring Data out precisely to
 * avoid jsonb mapping pain. jsonb columns come back as text and are parsed with
 * Jackson here, so the rest of the service works with JsonNode.
 */
@Repository
public class ProblemRepository {

    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;
    private final RowMapper<ProblemRow> problemMapper;

    public ProblemRepository(JdbcTemplate jdbc, ObjectMapper mapper) {
        this.jdbc = jdbc;
        this.mapper = mapper;
        this.problemMapper = (rs, n) -> {
            try {
                return new ProblemRow(
                        rs.getString("id"),
                        rs.getString("title"),
                        rs.getString("description"),
                        mapper.readTree(rs.getString("examples")),
                        rs.getString("starter_code"),
                        rs.getString("harness_python"),
                        mapper.readTree(rs.getString("rubric")),
                        rs.getInt("rubric_version"),
                        rs.getBigDecimal("cpu_time_limit"),
                        rs.getBigDecimal("wall_time_limit"),
                        rs.getInt("memory_limit_kb"),
                        rs.getString("kind"),
                        rs.getString("owner_id"),
                        rs.getString("language"),
                        rs.getString("constraints_text"),
                        rs.getString("source"),
                        rs.getString("source_site"),
                        mapper.readTree(rs.getString("insights")));
            } catch (Exception e) {
                throw new IllegalStateException(
                        "problem " + rs.getString("id") + " has unparseable jsonb", e);
            }
        };
    }

    private static final RowMapper<TestRow> TEST_MAPPER = (rs, n) -> new TestRow(
            rs.getInt("idx"),
            rs.getString("label"),
            rs.getBoolean("is_public"),
            rs.getString("stdin"),
            rs.getString("expected_output"));

    public Optional<ProblemRow> findProblem(String id) {
        List<ProblemRow> rows = jdbc.query("""
                SELECT id, title, description, examples, starter_code, harness_python,
                       rubric, rubric_version, cpu_time_limit, wall_time_limit, memory_limit_kb,
                       kind, owner_id, language, constraints_text, source, source_site, insights
                  FROM app.problems
                 WHERE id = ?
                """, problemMapper, id);
        return rows.stream().findFirst();
    }

    /** All tests for a problem, in index order. Hidden ones included. */
    public List<TestRow> findTests(String problemId) {
        return jdbc.query("""
                SELECT idx, label, is_public, stdin, expected_output
                  FROM app.hidden_tests
                 WHERE problem_id = ?
                 ORDER BY idx
                """, TEST_MAPPER, problemId);
    }

    public int countTests(String problemId) {
        Integer n = jdbc.queryForObject(
                "SELECT count(*) FROM app.hidden_tests WHERE problem_id = ?", Integer.class, problemId);
        return n == null ? 0 : n;
    }

    public int countCustomProblems(String ownerId) {
        Integer n = jdbc.queryForObject(
                "SELECT count(*) FROM app.problems WHERE kind = 'custom' AND owner_id = ?",
                Integer.class, ownerId);
        return n == null ? 0 : n;
    }

    /** Curated samples first, then this user's own problems, newest first. */
    public List<ProblemSummary> listVisible(String userId) {
        return jdbc.query("""
                SELECT id, title, kind, language, created_at
                  FROM app.problems
                 WHERE kind = 'curated' OR (kind = 'custom' AND owner_id = ?)
                 ORDER BY (kind = 'custom'), created_at DESC, id
                 LIMIT 200
                """, (rs, n) -> new ProblemSummary(
                        rs.getString("id"), rs.getString("title"), rs.getString("kind"),
                        rs.getString("language"),
                        rs.getTimestamp("created_at").toInstant().toString()),
                userId);
    }

    /**
     * Stores a validated custom problem and its tests in one transaction.
     *
     * <p>The id is opaque and unguessable ({@code custom-<uuid>}): problem ids end
     * up in URLs, and the session thread is derived from user + problem id, so a
     * sequential id would invite probing. Ownership is still checked on every read.
     *
     * <p>Student-supplied tests are stored as public: the student wrote them, so
     * there is nothing to hide, and the harness is empty because the program
     * reads stdin and prints its answer itself.
     */
    @Transactional
    public String insertCustom(String ownerId, CreateProblemRequest req, String title) {
        String id = "custom-" + UUID.randomUUID();
        String examples;
        try {
            examples = mapper.writeValueAsString(
                    req.examples() == null ? List.of() : req.examples().stream()
                            .map(e -> java.util.Map.of(
                                    "input", nz(e.input()),
                                    "output", nz(e.output()),
                                    "explanation", nz(e.explanation())))
                            .toList());
        } catch (Exception e) {
            throw new IllegalStateException("cannot serialise examples", e);
        }

        String insights;
        try {
            insights = req.insights() == null || req.insights().isNull()
                    ? "{}" : mapper.writeValueAsString(req.insights());
        } catch (Exception e) {
            throw new IllegalStateException("cannot serialise insights", e);
        }

        jdbc.update("""
                INSERT INTO app.problems
                  (id, title, description, examples, starter_code, harness_python,
                   rubric, rubric_version, kind, owner_id, language, constraints_text,
                   source, source_site, insights)
                VALUES (?, ?, ?, ?::jsonb, ?, '', '{}'::jsonb, 1, ?, ?, ?, ?, ?, ?, ?::jsonb)
                """,
                id, title, req.statement().strip(), examples, nz(req.starter_code()),
                Models.KIND_CUSTOM, ownerId, req.language() == null ? "python" : req.language(),
                nz(req.constraints()).strip(),
                req.source() == null || req.source().isBlank() ? "form" : req.source(),
                nz(req.source_site()).strip(), insights);

        List<TestInput> tests = req.tests() == null ? List.of() : req.tests();
        for (int i = 0; i < tests.size(); i++) {
            TestInput t = tests.get(i);
            String label = t.label() == null || t.label().isBlank() ? "test " + (i + 1) : t.label().strip();
            jdbc.update("""
                    INSERT INTO app.hidden_tests (problem_id, idx, label, is_public, stdin, expected_output)
                    VALUES (?, ?, ?, TRUE, ?, ?)
                    """, id, i + 1, label, nz(t.input()), nz(t.expected_output()));
        }
        return id;
    }

    /**
     * Records one version of the student's on-screen code. The same code seen
     * again is not stored twice. Returns true if it was new.
     */
    public boolean addSnapshot(String problemId, String ownerId, String language, String code) {
        String sha = sha256(code);
        int n = jdbc.update("""
                INSERT INTO app.solve_snapshots (problem_id, owner_id, language, code, code_sha)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (problem_id, owner_id, code_sha) DO NOTHING
                """, problemId, ownerId, nz(language), code, sha);
        return n > 0;
    }

    public int countSnapshots(String problemId) {
        Integer n = jdbc.queryForObject(
                "SELECT count(*) FROM app.solve_snapshots WHERE problem_id = ?", Integer.class, problemId);
        return n == null ? 0 : n;
    }

    private static String sha256(String s) {
        try {
            byte[] d = java.security.MessageDigest.getInstance("SHA-256")
                    .digest(s.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            return java.util.HexFormat.of().formatHex(d);
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private static String nz(String s) {
        return s == null ? "" : s;
    }
}
