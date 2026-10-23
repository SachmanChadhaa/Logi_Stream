"""Temporal memory, feature schema v1, diagnose node, intel fallback, observer.

No network: Java, the LLM, Ollama and the Rust sidecar are all stubbed or
pointed at a closed port, which is exactly the "everything optional is down"
case the brief requires to keep working.
"""
from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest
from langgraph.types import Command

from app import features_v1, intel_client, observer, temporal
from app.graph import build_graph
from app.state import initial_state

GOLDEN = Path(__file__).resolve().parents[2] / "intel" / "tests" / "golden_v1.json"


# ------------------------------------------------------------ feature schema

def test_golden_vector_matches_python():
    g = json.loads(GOLDEN.read_text(encoding="utf-8"))
    assert g["schema"] == features_v1.SCHEMA_VERSION
    assert g["dim"] == features_v1.DIM == len(g["vector"])
    assert g["features"] == list(features_v1.FEATURES), "slot order is the contract"
    assert g["causes"] == list(features_v1.CAUSES)
    assert features_v1.build(**g["input"]) == g["vector"]


def test_vector_is_bounded_and_one_hot():
    v = features_v1.build(event_kind="chat")
    assert len(v) == features_v1.DIM and all(0.0 <= x <= 1.0 for x in v)
    names = features_v1.FEATURES
    assert v[names.index("event_chat")] == 1.0 and v[names.index("err_none")] == 1.0
    assert sum(v[names.index(f"err_{c}")] for c in features_v1.ERROR_CATEGORIES) == 1.0


# ------------------------------------------------------------ temporal memory

def test_events_are_capped_and_never_hold_images():
    t = temporal.empty()
    for i in range(30):
        t = temporal.add_event(t, "chat", "x" * 1000, "student")
    assert len(t["events"]) == temporal.MAX_EVENTS
    assert all(len(e["text"]) <= temporal.MAX_EVENT_TEXT for e in t["events"])


def test_observation_goes_stale_after_a_newer_run():
    t = temporal.add_event(temporal.empty(), "observation", "KeyError in terminal", "screen")
    assert not temporal.is_stale(t["events"][0], t)
    t["code_revision"] += 1                       # a run happened
    assert temporal.is_stale(t["events"][0], t)
    assert "SEEN ON SCREEN EARLIER" in temporal.for_prompt(t)
    assert temporal.for_view(t)["events"][0]["stale"] is True


def test_frame_captured_before_a_run_is_stale_even_if_interpreted_after():
    t = temporal.empty()
    t["code_revision"] = 3
    t = temporal.add_event(t, "observation", "old frame", "screen", code_revision=2)
    assert temporal.is_stale(t["events"][0], t)


def test_view_hides_hidden_state_and_code():
    t = temporal.empty()
    t["gru"] = {"hidden": [0.1] * 32, "model_version": "v0"}
    t["last_run_code"] = "secret = 1"
    v = temporal.for_view(t)
    assert "gru" not in v and "last_run_code" not in v


def test_changed_lines():
    assert temporal.changed_lines("a\nb\nc", "a\nB\nc") == 2
    assert temporal.changed_lines("", "x\ny") == 2


# ------------------------------------------------------------ intel fallback

def test_intel_down_returns_none(monkeypatch):
    monkeypatch.setattr(intel_client, "INTEL_URL", "http://127.0.0.1:9")   # closed port
    assert intel_client.track([0.0] * features_v1.DIM, None) is None
    assert intel_client.rank([0.0] * features_v1.DIM, None, ["syntax"]) is None


def test_intel_rejects_wrong_dimension():
    assert intel_client.track([0.0] * 3, None) is None


# ------------------------------------------------------------ the graph, end to end

CTX = {"id": "custom-x", "title": "Echo", "description": "Print the input.", "rubric": {},
       "rubric_version": 1, "starter_code": "", "kind": "custom", "constraints": "",
       "examples": [], "language": "python"}


@pytest.fixture
def g(monkeypatch):
    from app import domain_client, llm
    monkeypatch.setattr(intel_client, "INTEL_URL", "http://127.0.0.1:9")
    monkeypatch.setattr(domain_client, "get_problem_context", lambda *a, **k: CTX)

    def fake_execute(problem_id, source, **k):
        bad = "oops" in source
        return {"bucket": "RUNTIME_ERROR" if bad else "ACCEPTED", "passed": 0 if bad else 1, "total": 1,
                "tests": [{"index": 1, "label": "t", "is_public": True, "passed": not bad,
                           "status_description": "x", "stdin": "a", "expected": "a",
                           "stdout": "" if bad else "a",
                           "stderr": 'File "s/solution.py", line 1\nNameError: name \'oops\' is not defined'
                           if bad else ""}]}
    monkeypatch.setattr(domain_client, "execute", fake_execute)

    def no_llm(**k):
        raise RuntimeError("LLM down")
    monkeypatch.setattr(llm, "complete", no_llm)
    return build_graph()


def _cfg(t="t1"):
    return {"configurable": {"thread_id": t}}


def test_custom_flow_with_everything_optional_down(g):
    g.invoke(initial_state("custom-x", "u", "t1", kind="custom"), _cfg())

    # an observation before any run
    g.invoke(Command(resume={"type": "observe", "text": "editor open",
                             "observation": {"text": "editor open", "tags": {"editing": True},
                                             "code_revision": 0}}), _cfg())
    v = g.get_state(_cfg()).values
    assert v["node_path"] == ["await_input", "diagnose"], "observer never triggers a tutor turn"
    assert v["temporal"]["events"][-1]["kind"] == "observation"
    assert not any(m["role"] == "tutor" for m in v["messages"])

    # a failing run: rules ranker, fallback hint, observation now stale
    g.invoke(Command(resume={"type": "code", "text": "print(oops)"}), _cfg())
    v = g.get_state(_cfg()).values
    assert v["node_path"][:3] == ["await_input", "execute_code", "diagnose"]
    assert v["last_diagnosis"]["ranker_used"] == "rules-v1"
    assert v["last_diagnosis"]["candidates"][0]["id"] == "undefined-name"
    assert v["temporal"]["code_revision"] == 1
    assert temporal.is_stale(v["temporal"]["events"][0], v["temporal"])
    assert v["temporal"]["hypotheses"] and v["temporal"]["next_action"]
    hint = [m for m in v["messages"] if m["role"] == "tutor"][-1]["text"]
    assert hint.startswith("Verified: RUNTIME_ERROR")
    assert v["fallback_used"] is True

    # chat goes through diagnose too, and still gets the (fallback) tutor
    g.invoke(Command(resume={"type": "chat", "text": "help"}), _cfg())
    v = g.get_state(_cfg()).values
    assert v["node_path"][:3] == ["await_input", "diagnose", "code_tutor"]

    # the fix: ACCEPTED -> DONE, no hypotheses left
    g.invoke(Command(resume={"type": "code", "text": "print(input())"}), _cfg())
    v = g.get_state(_cfg()).values
    assert v["phase"] == "DONE"
    assert v["temporal"]["hypotheses"] == []
    assert "verified by tests" in v["temporal"]["summary"]


# ------------------------------------------------------------ observer guards

PNG_1PX = base64.b64encode(
    b"\x89PNG\r\n\x1a\n" + b"\x00" * 32).decode()


def test_frame_validation():
    assert observer.decode_frame(PNG_1PX)
    assert observer.decode_frame("data:image/png;base64," + PNG_1PX)
    with pytest.raises(observer.BadFrame):
        observer.decode_frame("not base64!!")
    with pytest.raises(observer.BadFrame):
        observer.decode_frame(base64.b64encode(b"GIF89a....").decode())
    with pytest.raises(observer.BadFrame):
        observer.decode_frame(base64.b64encode(b"\xff\xd8\xff" + b"0" * 3_000_000).decode())


def test_ollama_must_be_local():
    observer._assert_local("http://localhost:11434")
    observer._assert_local("http://127.0.0.1:11434")
    with pytest.raises(RuntimeError):
        observer._assert_local("https://api.example.com")


def test_parse_reply_never_invents_an_error():
    r = observer.parse_reply('{"activity":"terminal","error_visible":true,"error_text":"","summary":"s"}')
    assert r["tags"]["error_visible"] is False, "no text, no error"
    r = observer.parse_reply('```json\n{"activity":"editing","error_visible":true,'
                             '"error_text":"KeyError: 3","summary":"editing two_sum"}\n```')
    assert r["tags"] == {"error_visible": True, "editing": True, "terminal": False, "offtask": False}
    assert "KeyError: 3" in r["text"]
    with pytest.raises(observer.ObserverUnavailable):
        observer.parse_reply("I cannot see anything")


def test_ollama_down_is_reported_not_raised(monkeypatch):
    monkeypatch.setattr(observer, "OLLAMA_URL", "http://127.0.0.1:9")
    s = observer.status()
    assert s["available"] is False and "not running" in s["detail"]
    with pytest.raises(observer.ObserverUnavailable):
        observer.interpret(PNG_1PX)


# ------------------------------------------------------------ booster modes

def _diag():
    return {"candidates": [
        {"id": "prints-nothing", "cause": "a", "next_action": "x", "score": 0.85, "evidence": ["e1"]},
        {"id": "logic-wrong-on-case", "cause": "b", "next_action": "y", "score": 0.6, "evidence": ["e2"]},
    ]}


def test_shadow_booster_never_reorders(monkeypatch):
    from app.nodes import diagnose as d
    monkeypatch.setattr(intel_client, "rank", lambda *a, **k: {
        "ranked": [{"id": "logic-wrong-on-case", "score": 2.0}, {"id": "prints-nothing", "score": -1.0}],
        "model_version": "booster-v0-synthetic", "promoted": False})
    diag = _diag()
    assert d._rerank(diag, [0.0] * features_v1.DIM, None) == d.SHADOW
    assert [c["id"] for c in diag["candidates"]] == ["prints-nothing", "logic-wrong-on-case"]
    assert diag["candidates"][1]["model_score"] == 2.0, "scores ride along for display"


def test_promoted_booster_reorders_but_never_adds(monkeypatch):
    from app.nodes import diagnose as d
    monkeypatch.setattr(intel_client, "rank", lambda *a, **k: {
        "ranked": [{"id": "syntax", "score": 9.0}, {"id": "logic-wrong-on-case", "score": 2.0},
                   {"id": "prints-nothing", "score": -1.0}],
        "model_version": "booster-v0-synthetic", "promoted": True})
    diag = _diag()
    assert d._rerank(diag, [0.0] * features_v1.DIM, None) == d.BOOSTED
    assert [c["id"] for c in diag["candidates"]] == ["logic-wrong-on-case", "prints-nothing"]


def test_gru_step_stores_hidden_state_and_student_state(monkeypatch):
    from app.nodes import diagnose as d
    monkeypatch.setattr(intel_client, "track", lambda v, h, **k: {
        "hidden": [0.1] * 32, "state_label": "stuck", "state_scores": {"stuck": 0.7},
        "cause_scores": {}, "model_version": "gru-v0-synthetic"})
    t = temporal.empty()
    d._gru_step(t, [0.0] * features_v1.DIM)
    assert t["gru"] == {"hidden": [0.1] * 32, "model_version": "gru-v0-synthetic"}
    assert t["student_state"]["label"] == "stuck"
