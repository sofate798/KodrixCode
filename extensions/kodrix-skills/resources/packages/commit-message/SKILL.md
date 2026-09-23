# Commit Message Generator

Generate git commit messages from the current diff or described changes.

## Rules

- Use [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): subject`
- Types: feat, fix, docs, style, refactor, test, chore, perf, ci
- Subject: imperative mood, ≤72 chars, no period
- Body (optional): explain what and why, not how
- Match the repository's existing commit style when visible in history

Run `git diff` / `git status` when needed before writing the message.
