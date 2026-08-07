"""
Agent entry points for running the CaptchaArena benchmark.
"""

from typing import Optional


def computeruse_main(argv: Optional[list[str]] = None) -> int:
    try:
        from .computeruse_cli import main as _main
    except Exception as exc:  # pragma: no cover - dependency guard
        raise ImportError(f'computer-use CLI dependencies are not available: {exc}') from exc
    return _main(argv)


main = computeruse_main

__all__ = ["computeruse_main", "main"]
