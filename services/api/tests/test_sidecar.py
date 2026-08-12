"""The desktop sidecar's two guarantees: it dies with its parent, and it does
not listen to the network.

Both are here because they fail *silently*. An orphaned sidecar still answers
health checks, so nothing in the app notices it; the cost is a held port and a
few hundred megabytes per crashed session. A 0.0.0.0 bind works perfectly for
the user who set it, and exposes an unauthenticated Chromium-backed exporter to
whoever else can reach the host.
"""

from __future__ import annotations

import os
import threading

import pytest

from figureforge.sidecar import (
    LOOPBACK_HOSTS,
    build_parser,
    main,
    parent_is_gone,
    watch_parent,
)


class TestParentIsGone:
    def test_same_parent_is_alive(self) -> None:
        assert parent_is_gone(4242, 4242) is False

    def test_reparented_process_is_orphaned(self) -> None:
        # POSIX reparents an orphan, so the pid simply stops matching.
        assert parent_is_gone(4242, 1) is True

    def test_detects_a_subreaper_parent(self) -> None:
        """The case a `ppid == 1` test would miss.

        Under a subreaper (systemd user sessions, containers with an init)
        an orphan is reparented to an ordinary process, not to pid 1.
        """
        assert parent_is_gone(4242, 9001) is True

    def test_zero_disables_the_watchdog(self) -> None:
        # 0 is how the CLI says "no parent to watch"; it must never read as
        # orphaned, or the service would exit immediately when run by hand.
        assert parent_is_gone(0, 1) is False


class TestWatchParent:
    def test_fires_once_the_parent_changes(self, monkeypatch: pytest.MonkeyPatch) -> None:
        fired = threading.Event()
        monkeypatch.setattr(os, "getppid", lambda: 777)

        watch_parent(4242, fired.set, interval_s=0.01)

        assert fired.wait(timeout=2.0), "watchdog did not fire for an orphaned process"

    def test_stays_quiet_while_the_parent_lives(self, monkeypatch: pytest.MonkeyPatch) -> None:
        fired = threading.Event()
        stop = threading.Event()
        monkeypatch.setattr(os, "getppid", lambda: 4242)

        watch_parent(4242, fired.set, interval_s=0.01, stop=stop)
        try:
            assert not fired.wait(timeout=0.2)
        finally:
            stop.set()

    def test_stop_event_ends_the_thread(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(os, "getppid", lambda: 4242)
        stop = threading.Event()
        thread = watch_parent(4242, lambda: None, interval_s=0.01, stop=stop)

        stop.set()
        thread.join(timeout=2.0)
        assert not thread.is_alive()


class TestBind:
    @pytest.mark.parametrize("host", sorted(LOOPBACK_HOSTS))
    def test_loopback_hosts_are_accepted(self, host: str) -> None:
        args = build_parser().parse_args(["--host", host, "--port", "8123"])
        assert args.host == host

    def test_refuses_a_public_bind(self) -> None:
        with pytest.raises(SystemExit) as caught:
            main(["--host", "0.0.0.0", "--port", "8123"])
        assert "unauthenticated" in str(caught.value)

    def test_allow_remote_is_an_explicit_opt_in(self) -> None:
        args = build_parser().parse_args(
            ["--host", "0.0.0.0", "--port", "8123", "--allow-remote"]
        )
        assert args.allow_remote is True

    def test_port_is_required(self) -> None:
        # Defaulting it would let two sidecars collide on one port, which
        # surfaces as a health check that passes against the wrong process.
        with pytest.raises(SystemExit):
            build_parser().parse_args(["--host", "127.0.0.1"])
