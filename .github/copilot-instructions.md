# Minicode — AI Agent Instructions

## Project Identity

**Minicode** is an open-source, AI-first IDE forked from VS Code, designed to rival Cursor, Trae, Qoder, Kiro, and Windsurf. It provides local LLM support (Ollama, llama.cpp, LM Studio) via BYOK alongside cloud APIs (DeepSeek, OpenRouter, Anthropic, Gemini), plus a full multi-agent AI coding experience.

## Architecture Overview

```
minicode/
├── src/vs/                    # Core VS Code fork (minimal modifications)
├── extensions/
│   ├── minicode-local/        # Model providers, BYOK, Cursor feature emulation, onboarding, Agents window
│   ├── minicode-skills/       # Skill marketplace sidebar, skill installation from GitHub/URL
│   ├── minicode-solo/         # SOLO Builder (4-panel: Plan, Chat, Terminal, Preview), @solo chat participant
│   └── minicode-agent-os/     # Agent OS: Wiki, Memory, Learning Engine, Spec workbench, Kanban, Router, Arena
├── build/                     # Gulp build system + Azure Pipelines CI/CD
├── cli/                       # Rust CLI tool for remote/tunnel features
├── marketplace/               # Built-in skill packages catalog
└── product.json               # Branding & product configuration
```

### Extension Dependency Chain

```
minicode-local  ──(commands)──>  minicode-agent-os
minicode-agent-os  ──(commands)──>  minicode-solo
minicode-skills  ──(settings)──>  (consumed by other extensions)
```

Extensions communicate via `vscode.commands.executeCommand()` — there are no formal `extensionDependencies` declared.

## Coding Guidelines

### TypeScript Standards
- Use TypeScript strict mode. Avoid `any` — prefer `unknown` and type guards.
- **NEVER** use `as` cast on `JSON.parse()` results without runtime validation. Use Zod or manual schema checks.
- All new code must pass `npm run eslint` with zero warnings.
- Use `import type` for type-only imports to avoid circular dependency risks.

### Extension Architecture
- **No `onStartupFinished` in new activation events** — use `onCommand`, `onView`, or `onChatParticipant` for lazy loading.
- Dispose all resources in `deactivate()` — use `context.subscriptions.push()` for disposables.
- **Store all `setTimeout`/`setInterval` handles** and clear them in dispose callbacks.
- Module-level mutable state (panels, watchers, timers) must be reset to `undefined` on deactivation.
- Use `vscode.OutputChannel` for logging, NOT `console.log`/`console.warn`.
- All file I/O in the extension host must use async `fs.promises` APIs — synchronous I/O blocks the host.
- Event listeners from `onDidDispose`, `onDidChange`, etc. must be pushed to `context.subscriptions`.

### Security
- Validate all user-supplied file paths for path traversal (`../`, absolute paths).
- Never construct shell commands with string interpolation from user input — use `child_process.spawn` with argument arrays.
- All network requests must have timeouts and size limits.
- Never hardcode secrets, tokens, or internal service URLs.

### Testing
- ALL new modules require unit tests in `src/test/unit/`.
- Integration tests for cross-extension command interactions go in `src/test/integration/`.
- Run `npm run test-extension` before committing to any Minicode extension.

## Extension-Specific Conventions

### minicode-local
- Config migration logic lives in `migrateConfig.ts` — never modify user config directly.
- Provider storage uses `context.globalState` via `providerStore.ts`.
- Cursor import logic (`cursorImport.ts`) must handle all Cursor versions gracefully with structured error reporting.

### minicode-solo
- `soloParticipant.ts` is the `@solo` chat participant — keep prompts in `resources/` not inline.
- `soloBuildTracker.ts` tracks file changes during Agent builds — ensure watchers and timers are properly disposed.
- SOLO Workbench panels must reset module-level state on dispose.

### minicode-skills
- Skill installation MUST validate with `sanitizeSkillName()` and `validateNoPathTraversal()`.
- Built-in skills are in `marketplace/packages/` and `resources/packages/`.
- Never overwrite existing skills without user confirmation.

### minicode-agent-os
- Learning data persists to `~/.minicode/memory/<project-hash>/` — never store in workspace folder.
- Memory and learning engines use `withLogLock()` for concurrent write safety.
- The router (`agentRouter.ts`) is rule-based — add new patterns to the scoring engine, not ad-hoc if/else chains.
- Panel lifecycle is managed by `utils/panelTracker.ts` — use `createTrackedPanel()` for all webviews.

## Validation Checklist

Before submitting PRs, verify:
1. `npm run eslint` passes with zero warnings
2. `npm run compile` completes without errors
3. All disposables are properly registered in `context.subscriptions`
4. No `console.warn`/`console.log` in new code (use OutputChannel)
5. No synchronous `fs.*Sync` in extension host code paths
6. All timers have stored handles and cleanup logic
7. New commands are documented in the extension's README
8. Configuration changes are reflected in `package.json` contributions
