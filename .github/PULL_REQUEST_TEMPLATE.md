## Summary
<!-- Brief description of what this PR does and why -->

## Type
- [ ] Bug fix
- [ ] New feature
- [ ] Enhancement / improvement
- [ ] Refactoring
- [ ] Documentation
- [ ] CI / build
- [ ] Security fix

## Area
- [ ] kodrix-local
- [ ] kodrix-skills
- [ ] kodrix-agent-os
- [ ] Core (src/vs/)
- [ ] Build / CI
- [ ] CLI
- [ ] Marketplace / skills

## Test Plan
<!-- How was this tested? What scenarios were verified? -->

- [ ] Unit tests added / updated
- [ ] Integration tests added / updated
- [ ] Manual testing performed
- [ ] N/A (documentation / config only)

## Checklist
- [ ] `npm run eslint` passes with zero warnings
- [ ] `npm run compile` completes without errors
- [ ] All disposables registered in `context.subscriptions`
- [ ] No `console.warn`/`console.log` in extension code (use OutputChannel)
- [ ] All `setTimeout`/`setInterval` handles stored for cleanup
- [ ] No synchronous `fs.*Sync` in extension host paths
- [ ] JSON deserialization validated (not bare `as Type` cast)
- [ ] Path traversal protection for user-supplied file paths
- [ ] Network requests have timeouts and size limits
