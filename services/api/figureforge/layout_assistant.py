"""AI layout helper: turning what a panel means into a small, closed instruction.

Nothing here knows about millimetres, frames or `GroupNode`s — those stay the
deterministic smart-layout solver's job (`packages/doc-model/src/smart-layout.ts`
on the TypeScript side). What lives here is strictly upstream of it: reading a
panel's *content* (its plot type, axis titles, dataset, caption) and turning
that into one of a small, closed set of instructions the client can act on
through document operations that already exist and are already tested
(`addGroup`) or the one small deterministic lever the solver gained for this
feature (`SmartLayoutOptions.sizeMultipliers`).

The LLM is never trusted with anything that executes. `suggest_grouping` and
`interpret_instruction` both validate the model's JSON reply against the
panels actually supplied — an id it invented, a group of fewer than two
panels (`addGroup` itself refuses those), or a reply that does not match one
of the closed shapes below all collapse to the same thing a genuinely
out-of-scope request does: `LayoutInstruction(kind="unsupported", ...)`. There
is no path from a malformed or hallucinated reply to a crash, and no path from
one to an action.

`LlmClient` is the injected-effect seam — the same discipline
`apps/desktop/src/sidecar.ts` takes with its `spawn`/`probe` parameters. Two
implementations exist: `llm_stub.StubLlmClient` (deterministic, no network,
what this module's own tests and the default `/layout/*` endpoints run
against today) and `llm_anthropic.AnthropicLlmClient` (written, but not the
default — see `main.py`'s `AI_LAYOUT_ASSISTANT_BACKEND`). Everything in this
module is exercised and correct against the stub without ever needing a real
key.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol

# ---------------------------------------------------------------------------
# What a panel is described by, and what comes back
# ---------------------------------------------------------------------------


@dataclass
class PanelSummary:
    """Metadata only — never pixel data, never the dataset's own values.

    This is the whole of what the assistant is told a panel is. Sending
    anything more (raw numbers, images) would be both unnecessary for either
    task here and a real thing to have to reason about leaking.
    """

    panel_id: str
    letter: str
    plot_type: str | None
    axis_titles: list[str]
    dataset_name: str | None
    caption_text: str | None


@dataclass
class GroupSuggestion:
    panel_ids: list[str]
    rationale: str


@dataclass
class GroupingSuggestion:
    groups: list[GroupSuggestion]


@dataclass
class LayoutInstruction:
    """A closed shape, not free text — `main.py` serialises this verbatim.

    `panel_ids`/`panel_id`/`direction` are populated only for the `kind` they
    belong to; a client reading the wire form treats it as a discriminated
    union on `kind`, matching this shape exactly.
    """

    kind: Literal["group", "resize", "unsupported"]
    reason: str
    panel_ids: list[str] | None = None
    panel_id: str | None = None
    direction: Literal["bigger", "smaller"] | None = None


class LlmClient(Protocol):
    """One call: a prompt, and the JSON shape the reply must satisfy.

    Deliberately this narrow — a single `complete` rather than one method per
    task — because it is what a real model call actually is (a prompt in, a
    schema-constrained reply out), and because a wider interface would be
    harder to swap a real backend into later without also changing every
    caller.
    """

    def complete(self, prompt: str, schema: dict) -> dict: ...


_GROUPING_SCHEMA: dict = {
    "type": "object",
    "properties": {
        "groups": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "panelIds": {"type": "array", "items": {"type": "string"}},
                    "rationale": {"type": "string"},
                },
                "required": ["panelIds", "rationale"],
            },
        }
    },
    "required": ["groups"],
}

_INSTRUCTION_SCHEMA: dict = {
    "type": "object",
    "properties": {
        "kind": {"type": "string", "enum": ["group", "resize", "unsupported"]},
        "reason": {"type": "string"},
        "panelIds": {"type": "array", "items": {"type": "string"}},
        "panelId": {"type": "string"},
        "direction": {"type": "string", "enum": ["bigger", "smaller"]},
    },
    "required": ["kind", "reason"],
}


def _panel_line(p: PanelSummary) -> str:
    bits = [f"panel {p.letter} (id={p.panel_id})"]
    if p.plot_type:
        bits.append(f"type={p.plot_type}")
    if p.axis_titles:
        bits.append(f"axes=[{', '.join(p.axis_titles)}]")
    if p.dataset_name:
        # Quoted, not bare — a dataset name may contain spaces ("Cohort 1"),
        # and the stub's own regex parser (`llm_stub.py`) needs an
        # unambiguous end to the value. A real model reads English and would
        # not need this; the stub does.
        bits.append(f'dataset="{p.dataset_name}"')
    if p.caption_text:
        bits.append(f"caption={p.caption_text!r}")
    return " ".join(bits)


def _panels_block(panels: list[PanelSummary]) -> str:
    return "\n".join(_panel_line(p) for p in panels)


# ---------------------------------------------------------------------------
# Suggest grouping
# ---------------------------------------------------------------------------


def suggest_grouping(panels: list[PanelSummary], llm: LlmClient) -> GroupingSuggestion:
    """Ask what these panels' content suggests should be grouped, and validate the reply.

    A group of one is dropped rather than kept: `addGroup` itself refuses
    fewer than two members, so a lone survivor here would be applied as
    nothing at all. An id the model invented is dropped from its group before
    the size check runs, not after — a group that only "worked" because a
    hallucinated id padded it out to two is not a real group.
    """
    if len(panels) < 2:
        return GroupingSuggestion(groups=[])

    known_ids = {p.panel_id for p in panels}
    raw = llm.complete(
        "You are helping arrange a multi-panel scientific figure. Given the "
        "panels below, suggest which ones should be grouped together because "
        "they are part of one narrative (for example, all panels from one "
        "experiment, or all panels validating the same claim). Only propose "
        "a group of two or more panels; a panel with nothing else to join "
        "should not be forced into a group. Reply as JSON matching the given "
        "schema.\n\n" + _panels_block(panels),
        _GROUPING_SCHEMA,
    )

    groups: list[GroupSuggestion] = []
    raw_groups = raw.get("groups") if isinstance(raw, dict) else None
    for candidate in raw_groups if isinstance(raw_groups, list) else []:
        if not isinstance(candidate, dict):
            continue
        ids = candidate.get("panelIds")
        rationale = candidate.get("rationale")
        if not isinstance(ids, list) or not isinstance(rationale, str) or not rationale.strip():
            continue
        deduped = list(dict.fromkeys(i for i in ids if isinstance(i, str) and i in known_ids))
        if len(deduped) < 2:
            continue
        groups.append(GroupSuggestion(panel_ids=deduped, rationale=rationale.strip()[:500]))

    return GroupingSuggestion(groups=groups)


# ---------------------------------------------------------------------------
# Interpret a natural-language instruction
# ---------------------------------------------------------------------------


def interpret_instruction(
    instruction: str, panels: list[PanelSummary], llm: LlmClient
) -> LayoutInstruction:
    """Turn a plain-English ask into `group`, `resize`, or `unsupported`.

    Nothing outside this closed vocabulary is ever returned, whatever the
    model actually said — a reply naming an unrecognised `kind`, a resize
    with no valid `panelId`, or a group referencing fewer than two real panel
    ids all become `unsupported` with a reason, the same as a request this
    codebase's own stance would refuse to approximate (Fisher's exact above
    2x2, a plot type the data does not support).
    """
    instruction = instruction.strip()
    if not instruction:
        return LayoutInstruction(kind="unsupported", reason="No instruction was given.")

    known_ids = {p.panel_id for p in panels}
    raw = llm.complete(
        "You are helping arrange a multi-panel scientific figure. The panels "
        "are:\n" + _panels_block(panels) + "\n\nThe author asked: " + instruction + "\n\n"
        "Reply as JSON matching the given schema. Only two kinds of "
        "instruction are supported: 'group' (keep the named panels adjacent) "
        "and 'resize' (make one named panel bigger or smaller). Anything "
        "else — a specific position, a reordering, anything this schema "
        "cannot express — must be reported as 'unsupported' with a "
        "plain-English reason.",
        _INSTRUCTION_SCHEMA,
    )

    if not isinstance(raw, dict):
        return LayoutInstruction(
            kind="unsupported", reason="The assistant's reply could not be read."
        )

    reason_raw = raw.get("reason")
    reason = reason_raw.strip()[:500] if isinstance(reason_raw, str) and reason_raw.strip() else (
        "No reason was given."
    )
    kind = raw.get("kind")

    if kind == "group":
        ids = raw.get("panelIds")
        valid_ids = (
            list(dict.fromkeys(i for i in ids if isinstance(i, str) and i in known_ids))
            if isinstance(ids, list)
            else []
        )
        if len(valid_ids) >= 2:
            return LayoutInstruction(kind="group", reason=reason, panel_ids=valid_ids)
        return LayoutInstruction(
            kind="unsupported",
            reason="The assistant named panels this figure does not have, or fewer than two.",
        )

    if kind == "resize":
        panel_id = raw.get("panelId")
        direction = raw.get("direction")
        if isinstance(panel_id, str) and panel_id in known_ids and direction in (
            "bigger",
            "smaller",
        ):
            return LayoutInstruction(
                kind="resize", reason=reason, panel_id=panel_id, direction=direction
            )
        return LayoutInstruction(
            kind="unsupported",
            reason="The assistant named a panel this figure does not have.",
        )

    if kind == "unsupported":
        return LayoutInstruction(kind="unsupported", reason=reason)

    return LayoutInstruction(
        kind="unsupported",
        reason="The assistant's reply did not match a supported instruction shape.",
    )
