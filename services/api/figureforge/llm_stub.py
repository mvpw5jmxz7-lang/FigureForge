"""A deterministic stand-in for a real LLM client.

No network, no cost, no key required — this is what `layout_assistant.py`'s
functions run against by default (see `AI_LAYOUT_ASSISTANT_BACKEND` in
`main.py`), and what this module's own tests exercise. It is rule-based
rather than a language model: good enough to drive the assistant end to end
for development and testing, not a claim about what a real model would
suggest. Swapping in `llm_anthropic.AnthropicLlmClient` changes nothing
above this module — both satisfy the same `LlmClient.complete(prompt,
schema) -> dict` seam.

Dispatch reads the *schema* rather than the prompt text, because that is the
one thing a real structured-output call would also have available without
parsing English: the grouping schema's top level has no `kind` property, the
instruction schema's always does.
"""

from __future__ import annotations

import re

_PANEL_LINE_RE = re.compile(r"panel (?P<letter>\S+) \(id=(?P<id>[^)]+)\)(?P<rest>[^\n]*)")
_DATASET_RE = re.compile(r'dataset="(?P<dataset>[^"]*)"')
_INSTRUCTION_RE = re.compile(r"The author asked: (?P<instruction>.*?)\n\n", re.DOTALL)

_BIGGER_WORDS = ("bigger", "larger", "more room", "more space", "grow", "enlarge")
_SMALLER_WORDS = ("smaller", "shrink", "less room", "less space", "reduce")
_TOGETHER_WORDS = ("keep", "together", "near", "beside", "adjacent", "next to", "group")


class StubLlmClient:
    def complete(self, prompt: str, schema: dict) -> dict:
        if "kind" in schema.get("properties", {}):
            return self._interpret_instruction(prompt)
        return self._suggest_grouping(prompt)

    def _suggest_grouping(self, prompt: str) -> dict:
        by_dataset: dict[str, list[str]] = {}
        for match in _PANEL_LINE_RE.finditer(prompt):
            dataset_match = _DATASET_RE.search(match.group("rest"))
            if dataset_match:
                by_dataset.setdefault(dataset_match.group("dataset"), []).append(
                    match.group("id")
                )

        groups = [
            {
                "panelIds": ids,
                "rationale": f'These panels share the dataset "{dataset}".',
            }
            for dataset, ids in by_dataset.items()
            if len(ids) >= 2
        ]
        return {"groups": groups}

    def _interpret_instruction(self, prompt: str) -> dict:
        instr_match = _INSTRUCTION_RE.search(prompt)
        instruction = (instr_match.group("instruction") if instr_match else "").lower()

        panels = []
        for match in _PANEL_LINE_RE.finditer(prompt):
            rest = match.group("rest").lower()
            plot_type = None
            if "type=" in rest:
                plot_type = rest.split("type=", 1)[1].split()[0]
            panels.append(
                {
                    "letter": match.group("letter").lower(),
                    "id": match.group("id"),
                    "plot_type": plot_type,
                }
            )

        def matches(p: dict) -> bool:
            if p["letter"] and re.search(rf"\bpanel {re.escape(p['letter'])}\b", instruction):
                return True
            if p["plot_type"] and p["plot_type"] in instruction:
                return True
            return False

        named = [p for p in panels if matches(p)]
        bigger = any(w in instruction for w in _BIGGER_WORDS)
        smaller = any(w in instruction for w in _SMALLER_WORDS)
        together = any(w in instruction for w in _TOGETHER_WORDS)

        if together and len(named) >= 2:
            return {
                "kind": "group",
                "reason": "Keeping the named panels adjacent, as asked.",
                "panelIds": [p["id"] for p in named],
            }
        if (bigger or smaller) and len(named) == 1:
            direction = "bigger" if bigger else "smaller"
            return {
                "kind": "resize",
                "reason": f"Making panel {named[0]['letter']} {direction}, as asked.",
                "panelId": named[0]["id"],
                "direction": direction,
            }
        return {
            "kind": "unsupported",
            "reason": (
                "This assistant only understands keeping two or more named panels "
                "together, or making one named panel bigger or smaller."
            ),
        }
