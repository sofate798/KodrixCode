# Python Expert

Apply when writing or reviewing Python code.

## Standards

- Prefer type hints (PEP 484/585); use `from __future__ import annotations` when helpful
- Follow PEP 8; use `ruff`/`black`-compatible formatting
- Use `pathlib`, context managers, and dataclasses where appropriate
- Prefer composition; avoid unnecessary metaclasses
- Handle errors explicitly; avoid bare `except`
- For async code: structured concurrency, proper cancellation
- For performance: profile first; use `__slots__`, generators, or vectorization only when justified

Suggest tests with `pytest` when adding non-trivial logic.
