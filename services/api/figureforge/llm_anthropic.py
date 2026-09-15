"""A real LLM client, using Anthropic's Claude — written, but not the default.

Selected only when `AI_LAYOUT_ASSISTANT_BACKEND=anthropic` is set (see
`main.py`); `llm_stub.StubLlmClient` is the default until a key and a cost
model are actually settled. Behind the same `LlmClient.complete(prompt,
schema) -> dict` seam `layout_assistant.py` calls against the stub, so
nothing above this module needs to change when this backend is turned on.

`ANTHROPIC_API_KEY` is read only inside `__init__`, and only as a fallback —
a caller (`main.py`'s `_llm_client`) may instead pass a key straight through,
which is how a user's own in-app key reaches this class. This module is
imported only from inside `main.py`'s backend selector — never at module
load — so a deployment running the stub is entirely unaffected by either
source's absence.

Not exercised by this round's automated tests: doing so would need a real
key and would cost real money on every CI run, which is exactly why this
class exists behind an interface rather than being the only implementation.

`complete()` is a synchronous call — a real network request once this
backend is selected — and `main.py`'s endpoints are `async def`, so calling
it directly would block the event loop for the duration of the request.
`main.py`'s `_run_llm_task` already covers this: it runs `complete()` in a
thread (`asyncio.to_thread`), bounded by `_LAYOUT_ASSISTANT_SLOTS` (a
semaphore) and a wall-clock `asyncio.wait_for`, the same shape
`export/renderer.py` uses around Chromium — every caller of `LlmClient.complete`
goes through it, this class included, so nothing here has to solve that
itself.

Still genuinely missing, and left here rather than solved now: a per-request
or per-session call budget. Nothing anywhere in this feature limits how
often an author can trigger a real, billed API call once this backend is
selected.
"""

from __future__ import annotations

import os

import anthropic


class AnthropicLlmClient:
    def __init__(self, model: str = "claude-sonnet-5", api_key: str | None = None) -> None:
        resolved_key = api_key or os.getenv("ANTHROPIC_API_KEY")
        if not resolved_key:
            raise RuntimeError(
                "AI_LAYOUT_ASSISTANT_BACKEND=anthropic but ANTHROPIC_API_KEY is not set."
            )
        self._client = anthropic.Anthropic(api_key=resolved_key)
        self._model = model

    def complete(self, prompt: str, schema: dict) -> dict:
        response = self._client.messages.create(
            model=self._model,
            max_tokens=1024,
            tools=[
                {
                    "name": "reply",
                    "description": "Reply with structured JSON matching the given schema.",
                    "input_schema": schema,
                }
            ],
            tool_choice={"type": "tool", "name": "reply"},
            messages=[{"role": "user", "content": prompt}],
        )
        for block in response.content:
            if block.type == "tool_use":
                return block.input
        raise RuntimeError("Claude did not return a structured reply.")
