package com.logistream.domain.web;

import java.util.Map;
import java.util.Optional;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.logistream.domain.exec.ExecutionService;
import com.logistream.domain.model.Models.CreateProblemRequest;
import com.logistream.domain.model.Models.ExecuteRequest;
import com.logistream.domain.model.Models.ProblemContext;
import com.logistream.domain.model.Models.ProblemRow;
import com.logistream.domain.model.Models.ProblemView;
import com.logistream.domain.repo.ProblemRepository;

/**
 * Internal endpoints -- Python only. Everything under /internal/** is behind
 * InternalTokenFilter, and everything here may contain the rubric, hidden test
 * inputs and expected outputs.
 */
@RestController
@RequestMapping("/internal")
public class InternalController {

    private static final Logger log = LoggerFactory.getLogger(InternalController.class);

    private final ProblemRepository repo;
    private final ExecutionService executor;

    public InternalController(ProblemRepository repo, ExecutionService executor) {
        this.repo = repo;
        this.executor = executor;
    }

    public static final String USER_HEADER = "X-User-Id";

    /**
     * The problem for the tutor. When the caller names a user (Python does on
     * session start) a custom problem is only returned to its owner; a stranger
     * gets the same 404 as for an id that does not exist.
     */
    @GetMapping("/problems/{id}/context")
    public ResponseEntity<?> context(@PathVariable String id,
                                     @RequestHeader(value = USER_HEADER, required = false) String userId) {
        return visible(id, userId, userId != null)
                .<ResponseEntity<?>>map(p -> ResponseEntity.ok(new ProblemContext(
                        p.id(), p.title(), p.description(), p.rubric(),
                        p.rubricVersion(), p.starterCode(), p.kind(), p.constraintsText(),
                        p.examples(), p.language())))
                .orElseGet(() -> unknown(id));
    }

    /** The browser-safe view of any problem the user may see (gateway only). */
    @GetMapping("/problems/{id}/view")
    public ResponseEntity<?> view(@PathVariable String id,
                                  @RequestHeader(value = USER_HEADER, required = false) String userId) {
        return visible(id, userId, true)
                .<ResponseEntity<?>>map(p -> ResponseEntity.ok(viewOf(p, repo)))
                .orElseGet(() -> unknown(id));
    }

    /** Curated samples plus the user's own problems. */
    @GetMapping("/problems")
    public ResponseEntity<?> list(@RequestHeader(value = USER_HEADER, required = false) String userId) {
        if (userId == null || userId.isBlank()) {
            return ResponseEntity.badRequest().body(Map.of("error", USER_HEADER + " is required"));
        }
        return ResponseEntity.ok(Map.of("problems", repo.listVisible(userId)));
    }

    /** Bring your own problem: validate, store, return the browser-safe view. */
    @PostMapping("/problems")
    public ResponseEntity<?> create(@RequestBody(required = false) CreateProblemRequest req,
                                    @RequestHeader(value = USER_HEADER, required = false) String userId) {
        if (userId == null || userId.isBlank()) {
            return ResponseEntity.badRequest().body(Map.of("error", USER_HEADER + " is required"));
        }
        CustomProblemValidator.Violation v = CustomProblemValidator.validate(req);
        if (v != null) {
            log.info("create problem rejected field={} reason={}", v.field(), v.message());
            return ResponseEntity.status(422).body(Map.of("error", v.message(), "field", v.field()));
        }
        if (repo.countCustomProblems(userId) >= CustomProblemValidator.MAX_PROBLEMS_PER_USER) {
            return ResponseEntity.status(429).body(Map.of(
                    "error", "you already have " + CustomProblemValidator.MAX_PROBLEMS_PER_USER
                            + " problems; that is the limit for this demo"));
        }

        String id = repo.insertCustom(userId, req, CustomProblemValidator.titleFor(req));
        log.info("created custom problem id={} owner={} tests={} statement_chars={}",
                id, userId, req.tests() == null ? 0 : req.tests().size(), req.statement().length());

        ProblemRow p = repo.findProblem(id).orElseThrow();
        return ResponseEntity.status(201).body(viewOf(p, repo));
    }

    /** Field by field, so the rubric and hidden tests can never ride along. */
    static ProblemView viewOf(ProblemRow p, ProblemRepository repo) {
        return new ProblemView(p.id(), p.title(), p.description(), p.examples(),
                p.starterCode(), p.language(), p.kind(), p.constraintsText(),
                repo.countTests(p.id()));
    }

    private Optional<ProblemRow> visible(String id, String userId, boolean enforceOwner) {
        return repo.findProblem(id).filter(p -> !enforceOwner || p.visibleTo(userId));
    }

    private static ResponseEntity<?> unknown(String id) {
        return ResponseEntity.status(404).body(Map.of("error", "unknown problem: " + id));
    }

    @PostMapping("/execute")
    public ResponseEntity<?> execute(@RequestBody ExecuteRequest req) {
        if (req.problem_id() == null || req.problem_id().isBlank()) {
            return ResponseEntity.badRequest().body(Map.of("error", "problem_id is required"));
        }
        if (req.source() == null || req.source().isBlank()) {
            return ResponseEntity.badRequest().body(Map.of("error", "source is required"));
        }
        // MVP is python-only; language is already a field so adding more is config, not surgery
        String language = req.language() == null ? "python" : req.language();
        if (!CustomProblemValidator.SUPPORTED_LANGUAGES.contains(language.toLowerCase())) {
            return ResponseEntity.badRequest()
                    .body(Map.of("error", "unsupported language: " + language));
        }

        ProblemRow problem = repo.findProblem(req.problem_id()).orElse(null);
        if (problem == null) {
            return ResponseEntity.status(404)
                    .body(Map.of("error", "unknown problem: " + req.problem_id()));
        }

        log.info("execute request problem={} source_bytes={}", problem.id(), req.source().length());
        return ResponseEntity.ok(executor.execute(problem, req.source()));
    }
}
