"""AnthropicLlmClient.__init__ — key resolution only, no network call.

__init__ only constructs anthropic.Anthropic(api_key=...); it never calls
the network, so this is testable without a real key or a mock of the SDK's
HTTP layer.
"""

from __future__ import annotations

import pytest

from figureforge.llm_anthropic import AnthropicLlmClient


class TestKeyResolution:
    def test_an_explicit_api_key_is_used(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        client = AnthropicLlmClient(api_key="sk-ant-explicit")
        assert client._client.api_key == "sk-ant-explicit"

    def test_an_explicit_key_takes_precedence_over_the_env_var(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-from-env")
        client = AnthropicLlmClient(api_key="sk-ant-explicit")
        assert client._client.api_key == "sk-ant-explicit"

    def test_the_env_var_is_used_when_no_key_is_passed(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-from-env")
        client = AnthropicLlmClient()
        assert client._client.api_key == "sk-ant-from-env"

    def test_neither_source_present_raises(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        with pytest.raises(RuntimeError):
            AnthropicLlmClient()
