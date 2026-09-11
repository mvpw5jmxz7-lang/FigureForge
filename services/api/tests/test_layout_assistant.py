"""The AI layout assistant, checked entirely against the stub — no network.

`layout_assistant.py`'s whole job is validating whatever an `LlmClient`
returns before it can reach the document model, so most of this file drives
it with hand-built fake clients that return exactly the malformed/
hallucinated/well-formed shapes being tested, rather than the real stub —
the validation logic must not depend on the stub happening to behave. A
separate class exercises `StubLlmClient` itself, and a third hits the real
`/layout/*` routes end to end (`main.py`'s default backend is the stub, so
these need no key and make no network call, the same reasoning
`test_main_routes.py` documents for exercising a route rather than calling
the underlying function directly).
"""

from __future__ import annotations

import asyncio
import time

import pytest
from fastapi.testclient import TestClient

import figureforge.main as main_module
from figureforge.layout_assistant import (
    PanelSummary,
    interpret_instruction,
    suggest_grouping,
)
from figureforge.llm_stub import StubLlmClient
from figureforge.main import MAX_LAYOUT_PANELS, app

client = TestClient(app)


class FakeLlmClient:
    """Returns exactly what the test hands it, ignoring the prompt/schema."""

    def __init__(self, reply: object) -> None:
        self.reply = reply
        self.calls: list[tuple[str, dict]] = []

    def complete(self, prompt: str, schema: dict) -> dict:
        self.calls.append((prompt, schema))
        return self.reply  # type: ignore[return-value]


PANELS = [
    PanelSummary(
        panel_id="p1",
        letter="a",
        plot_type="bar-dot",
        axis_titles=["Time", "Signal"],
        dataset_name="Cohort 1",
        caption_text=None,
    ),
    PanelSummary(
        panel_id="p2",
        letter="b",
        plot_type="heatmap",
        axis_titles=[],
        dataset_name="Cohort 1",
        caption_text="Expression",
    ),
    PanelSummary(
        panel_id="p3",
        letter="c",
        plot_type="scatter",
        axis_titles=["X", "Y"],
        dataset_name="Cohort 2",
        caption_text=None,
    ),
]


class TestSuggestGrouping:
    def test_a_well_formed_group_survives(self):
        llm = FakeLlmClient(
            {"groups": [{"panelIds": ["p1", "p2"], "rationale": "Both cohort 1."}]}
        )
        outcome = suggest_grouping(PANELS, llm)
        assert len(outcome.groups) == 1
        assert outcome.groups[0].panel_ids == ["p1", "p2"]
        assert outcome.groups[0].rationale == "Both cohort 1."

    def test_a_hallucinated_panel_id_is_dropped_from_its_group(self):
        llm = FakeLlmClient(
            {
                "groups": [
                    {"panelIds": ["p1", "p2", "not-a-real-id"], "rationale": "ok"},
                ]
            }
        )
        outcome = suggest_grouping(PANELS, llm)
        assert outcome.groups[0].panel_ids == ["p1", "p2"]

    def test_a_group_left_with_fewer_than_two_real_ids_is_dropped_entirely(self):
        llm = FakeLlmClient(
            {"groups": [{"panelIds": ["p1", "invented"], "rationale": "ok"}]}
        )
        outcome = suggest_grouping(PANELS, llm)
        assert outcome.groups == []

    def test_a_group_of_one_real_panel_is_never_suggested_even_if_the_model_names_it(self):
        llm = FakeLlmClient({"groups": [{"panelIds": ["p1"], "rationale": "alone"}]})
        assert suggest_grouping(PANELS, llm).groups == []

    def test_malformed_json_produces_no_groups_rather_than_a_crash(self):
        for reply in (None, [], {"groups": "not a list"}, {"groups": [{"panelIds": "p1"}]}):
            assert suggest_grouping(PANELS, FakeLlmClient(reply)).groups == []

    def test_fewer_than_two_panels_never_calls_the_model_at_all(self):
        llm = FakeLlmClient({"groups": []})
        suggest_grouping(PANELS[:1], llm)
        assert llm.calls == []

    def test_duplicate_ids_in_one_group_are_deduplicated(self):
        llm = FakeLlmClient(
            {"groups": [{"panelIds": ["p1", "p1", "p2"], "rationale": "ok"}]}
        )
        outcome = suggest_grouping(PANELS, llm)
        assert outcome.groups[0].panel_ids == ["p1", "p2"]

    def test_no_pixel_or_raw_data_reaches_the_prompt(self):
        # PanelSummary carries only metadata to begin with, but this pins the
        # property directly: nothing numeric or image-shaped ever appears in
        # what the model is sent.
        llm = FakeLlmClient({"groups": []})
        suggest_grouping(PANELS, llm)
        prompt = llm.calls[0][0]
        assert "Cohort 1" in prompt and "heatmap" in prompt
        assert "base64" not in prompt.lower() and "png" not in prompt.lower()


class TestInterpretInstruction:
    def test_a_well_formed_group_instruction_survives(self):
        llm = FakeLlmClient(
            {"kind": "group", "reason": "asked", "panelIds": ["p1", "p2"]}
        )
        outcome = interpret_instruction("keep a and b together", PANELS, llm)
        assert outcome.kind == "group"
        assert outcome.panel_ids == ["p1", "p2"]
        assert outcome.reason == "asked"

    def test_a_well_formed_resize_instruction_survives(self):
        llm = FakeLlmClient(
            {"kind": "resize", "reason": "asked", "panelId": "p2", "direction": "bigger"}
        )
        outcome = interpret_instruction("make the heatmap bigger", PANELS, llm)
        assert outcome.kind == "resize"
        assert outcome.panel_id == "p2"
        assert outcome.direction == "bigger"

    def test_a_hallucinated_resize_panel_id_becomes_unsupported(self):
        llm = FakeLlmClient(
            {"kind": "resize", "reason": "x", "panelId": "not-real", "direction": "bigger"}
        )
        outcome = interpret_instruction("make it bigger", PANELS, llm)
        assert outcome.kind == "unsupported"

    def test_an_invalid_direction_becomes_unsupported(self):
        llm = FakeLlmClient(
            {"kind": "resize", "reason": "x", "panelId": "p2", "direction": "huge"}
        )
        assert interpret_instruction("x", PANELS, llm).kind == "unsupported"

    def test_a_group_instruction_naming_only_one_real_panel_becomes_unsupported(self):
        llm = FakeLlmClient({"kind": "group", "reason": "x", "panelIds": ["p1"]})
        assert interpret_instruction("x", PANELS, llm).kind == "unsupported"

    def test_the_models_own_unsupported_reply_passes_through(self):
        llm = FakeLlmClient({"kind": "unsupported", "reason": "Position is not supported."})
        outcome = interpret_instruction("put b in the top-left corner", PANELS, llm)
        assert outcome.kind == "unsupported"
        assert outcome.reason == "Position is not supported."

    def test_an_unrecognised_kind_becomes_unsupported(self):
        llm = FakeLlmClient({"kind": "reorder", "reason": "x"})
        assert interpret_instruction("x", PANELS, llm).kind == "unsupported"

    def test_malformed_json_becomes_unsupported_rather_than_a_crash(self):
        for reply in (None, [], "a string", {"kind": "group"}):
            outcome = interpret_instruction("x", PANELS, FakeLlmClient(reply))
            assert outcome.kind == "unsupported"

    def test_a_blank_instruction_never_reaches_the_model(self):
        llm = FakeLlmClient({"kind": "unsupported", "reason": "x"})
        outcome = interpret_instruction("   ", PANELS, llm)
        assert outcome.kind == "unsupported"
        assert llm.calls == []

    def test_a_missing_reason_is_reported_rather_than_left_blank(self):
        llm = FakeLlmClient({"kind": "resize", "panelId": "p2", "direction": "bigger"})
        outcome = interpret_instruction("x", PANELS, llm)
        assert outcome.reason


class TestStubLlmClient:
    """The deterministic stub itself, not the validation around it."""

    def test_groups_panels_that_share_a_dataset(self):
        outcome = suggest_grouping(PANELS, StubLlmClient())
        assert len(outcome.groups) == 1
        assert set(outcome.groups[0].panel_ids) == {"p1", "p2"}

    def test_no_group_is_offered_when_no_two_panels_share_a_dataset(self):
        distinct = [
            PanelSummary(panel_id=f"q{i}", letter=chr(97 + i), plot_type=None,
                          axis_titles=[], dataset_name=f"Dataset {i}", caption_text=None)
            for i in range(3)
        ]
        assert suggest_grouping(distinct, StubLlmClient()).groups == []

    def test_understands_a_resize_instruction_naming_a_plot_type(self):
        outcome = interpret_instruction("give the heatmap more room", PANELS, StubLlmClient())
        assert outcome.kind == "resize"
        assert outcome.panel_id == "p2"
        assert outcome.direction == "bigger"

    def test_understands_a_resize_instruction_naming_a_letter(self):
        outcome = interpret_instruction("shrink panel a a bit", PANELS, StubLlmClient())
        assert outcome.kind == "resize"
        assert outcome.panel_id == "p1"
        assert outcome.direction == "smaller"

    def test_understands_a_grouping_instruction_naming_two_panels(self):
        outcome = interpret_instruction(
            "keep panel a and panel b together", PANELS, StubLlmClient()
        )
        assert outcome.kind == "group"
        assert set(outcome.panel_ids or []) == {"p1", "p2"}

    def test_declines_a_position_instruction_it_does_not_support(self):
        outcome = interpret_instruction(
            "put panel c in the top-left corner", PANELS, StubLlmClient()
        )
        assert outcome.kind == "unsupported"


class TestRoutes:
    """Over real HTTP, against the default stub backend — no key, no network."""

    def _panel(self, panel_id: str, letter: str, plot_type: str, dataset: str) -> dict:
        return {
            "panelId": panel_id,
            "letter": letter,
            "plotType": plot_type,
            "axisTitles": [],
            "datasetName": dataset,
            "captionText": None,
        }

    def test_suggest_grouping_route(self):
        response = client.post(
            "/layout/suggest-grouping",
            json={
                "panels": [
                    self._panel("p1", "a", "bar-dot", "Cohort 1"),
                    self._panel("p2", "b", "heatmap", "Cohort 1"),
                    self._panel("p3", "c", "scatter", "Cohort 2"),
                ]
            },
        )
        assert response.status_code == 200
        body = response.json()
        assert body["groups"] and set(body["groups"][0]["panelIds"]) == {"p1", "p2"}

    def test_interpret_route(self):
        response = client.post(
            "/layout/interpret",
            json={
                "instruction": "make the heatmap bigger",
                "panels": [
                    self._panel("p1", "a", "bar-dot", "Cohort 1"),
                    self._panel("p2", "b", "heatmap", "Cohort 1"),
                ],
            },
        )
        assert response.status_code == 200
        body = response.json()
        assert body["kind"] == "resize"
        assert body["panelId"] == "p2"
        assert body["direction"] == "bigger"

    def test_too_many_panels_is_refused_with_422(self):
        panels = [
            self._panel(f"p{i}", "a", "bar-dot", "D") for i in range(MAX_LAYOUT_PANELS + 1)
        ]
        response = client.post("/layout/suggest-grouping", json={"panels": panels})
        assert response.status_code == 422

    def test_a_blank_instruction_is_refused_with_422(self):
        response = client.post(
            "/layout/interpret",
            json={"instruction": "", "panels": [self._panel("p1", "a", "bar-dot", "D")]},
        )
        assert response.status_code == 422

    def test_an_unknown_backend_is_refused_with_503(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv("AI_LAYOUT_ASSISTANT_BACKEND", "not-a-real-backend")
        response = client.post(
            "/layout/interpret",
            json={"instruction": "x", "panels": [self._panel("p1", "a", "bar-dot", "D")]},
        )
        assert response.status_code == 503


class TestRunLlmTask:
    """`_run_llm_task` itself — the mechanism that keeps a slow `LlmClient`
    (a real network call, once `AnthropicLlmClient` is selected) from
    blocking the event loop or hanging a request forever.

    Tested as a plain async unit, not through a route: FastAPI's
    `TestClient` runs each request through its own short-lived event loop,
    and tearing that loop down waits for its default `ThreadPoolExecutor` to
    drain — including a thread still running the slow call `wait_for`
    already gave up on — which would make a route-level timing assertion
    measure the test harness rather than the production server. A
    long-lived uvicorn process has no such teardown between requests, so the
    property that matters is provable directly against the coroutine.
    """

    def test_returns_promptly_when_the_backend_never_returns(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setattr(main_module, "LAYOUT_ASSISTANT_TIMEOUT_S", 0.05)

        def hangs() -> dict:
            time.sleep(5)
            return {"kind": "unsupported", "reason": "too slow to matter"}

        # A hand-managed loop, not `asyncio.run` — `asyncio.run`'s own
        # cleanup calls `shutdown_default_executor()`, which blocks until
        # every thread-pool task finishes, including the one `wait_for` just
        # gave up on. That is a real cost of a *short-lived* loop, not of a
        # long-lived uvicorn process (which never tears its loop down between
        # requests), and it would make this measurement time the wrong thing
        # — confirmed by writing it with `asyncio.run` first and watching it
        # report ~5 s instead of the timeout. `run_until_complete` carries no
        # such teardown, so it isolates the property this test is actually
        # about: does the *coroutine* return promptly.
        loop = asyncio.new_event_loop()
        try:
            started = time.monotonic()
            with pytest.raises(TimeoutError):
                loop.run_until_complete(main_module._run_llm_task(hangs))
            elapsed = time.monotonic() - started
        finally:
            loop.close()

        # Bounded by the timeout, not by the 5-second call — generous slack
        # for CI scheduling, but nowhere near the call itself.
        assert elapsed < 1.0

    def test_returns_the_value_when_the_backend_answers_in_time(self):
        result = asyncio.run(main_module._run_llm_task(lambda: {"kind": "unsupported"}))
        assert result == {"kind": "unsupported"}

    def test_passes_positional_arguments_through(self):
        result = asyncio.run(main_module._run_llm_task(lambda a, b: a + b, 2, 3))
        assert result == 5

