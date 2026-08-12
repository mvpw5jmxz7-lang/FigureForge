"""Run the API as a desktop sidecar: bound to loopback, and tied to its parent.

The web deployment runs this service as its own long-lived container, started
and stopped by whoever runs the pod. The desktop shell instead owns it as a
child process, and that changes two things.

**It must not outlive its parent.** The Electron supervisor kills this process
on quit, which covers every *cooperative* exit — but a SIGKILL, an OOM kill or
a hard power-off of the parent runs no handler at all, and the orphan left
behind holds a port and a few hundred megabytes of SciPy for the rest of the
session. So the watchdog here is not redundant with the supervisor: each one
covers exactly the case the other cannot see.

**It must not be reachable from the network.** The service has no
authentication because, as a container, it was never exposed beyond the pod.
On a laptop or a shared lab machine, a 0.0.0.0 bind would offer an
unauthenticated Chromium-backed exporter and image decoder to anyone who could
route to the host. The default here is 127.0.0.1 and the CLI refuses anything
else unless it is explicitly overridden.

`main.py` is deliberately untouched by all of this: the ASGI app is the same
object in both deployments, so there is no desktop-only code path through the
request handlers to diverge from what the tests cover.
"""

from __future__ import annotations

import argparse
import logging
import os
import threading
from collections.abc import Callable

logger = logging.getLogger("figureforge.sidecar")

#: How often the watchdog checks whether its parent is still there. A dead
#: parent frees this process within roughly this interval; polling faster buys
#: nothing, since the cost of a brief orphan is a port held a second longer.
WATCHDOG_INTERVAL_S = 1.0

LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1", "localhost"})


def parent_is_gone(expected_ppid: int, current_ppid: int) -> bool:
    """Has the process that started us exited?

    Kept as a pure predicate so the interesting case — reparenting, which is
    awkward to stage in a test — can be asserted directly rather than by
    orchestrating real process trees.

    On POSIX an orphan is reparented (to init, or to a subreaper), so the
    parent pid simply stops matching the one we were told to expect. Comparing
    against the *recorded* pid rather than testing for pid 1 is what makes this
    correct under a subreaper, where an orphan's new parent is an ordinary
    process id.
    """
    if expected_ppid <= 0:
        return False
    return current_ppid != expected_ppid


def watch_parent(
    expected_ppid: int,
    on_orphaned: Callable[[], None],
    *,
    interval_s: float = WATCHDOG_INTERVAL_S,
    stop: threading.Event | None = None,
) -> threading.Thread:
    """Start a daemon thread that calls `on_orphaned` once the parent exits."""
    finished = stop or threading.Event()

    def loop() -> None:
        while not finished.wait(interval_s):
            if parent_is_gone(expected_ppid, os.getppid()):
                logger.warning("parent %s exited; shutting down", expected_ppid)
                on_orphaned()
                return

    thread = threading.Thread(target=loop, name="parent-watchdog", daemon=True)
    thread.start()
    return thread


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="figureforge.sidecar",
        description="Run the FigureForge API as a desktop sidecar process.",
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument(
        "--parent-pid",
        type=int,
        default=0,
        help="Exit when this process disappears. 0 disables the watchdog.",
    )
    parser.add_argument(
        "--allow-remote",
        action="store_true",
        help="Permit a non-loopback bind. The service is unauthenticated; only "
        "use this when something else provides access control.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if args.host not in LOOPBACK_HOSTS and not args.allow_remote:
        raise SystemExit(
            f"Refusing to bind {args.host}: this service is unauthenticated. "
            "Pass --allow-remote if access control is provided elsewhere."
        )

    # Imported here rather than at module scope so `--help` and the argument
    # validation above stay fast; importing the app pulls in SciPy and umap.
    import uvicorn

    from .main import app

    server = uvicorn.Server(
        uvicorn.Config(app, host=args.host, port=args.port, log_level="info")
    )

    if args.parent_pid:
        # `should_exit` is uvicorn's own graceful-shutdown flag, so the browser
        # pool in the export renderer still gets its lifespan shutdown — a hard
        # exit here would leak a Chromium process, trading one orphan for
        # another.
        watch_parent(args.parent_pid, lambda: setattr(server, "should_exit", True))

    server.run()
    return 0


if __name__ == "__main__":  # pragma: no cover - process entry point
    raise SystemExit(main())
