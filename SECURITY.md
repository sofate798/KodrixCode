# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 1.x     | :white_check_mark: |

## Reporting a Vulnerability

**DO NOT CREATE A PUBLIC GITHUB ISSUE** for security vulnerabilities.

Instead, report vulnerabilities via one of these channels:

- **Email**: security@minicode.dev (preferred)
- **GitHub Security Advisory**: https://github.com/minicode/minicode/security/advisories/new

### What to Include

Please provide:

1. A clear description of the vulnerability
2. Steps to reproduce the issue
3. Affected components/versions
4. Potential impact
5. Any suggested mitigations

### Response Timeline

| Stage | Target |
|-------|--------|
| Initial acknowledgment | Within 48 hours |
| Confirmation & severity assessment | Within 5 business days |
| Patch release for Critical | Within 7 days |
| Patch release for High | Within 14 days |
| Public disclosure | After patch is released |

### Scope

This policy covers:

- The Minicode IDE application (Electron shell, VS Code fork)
- Minicode extensions (minicode-local, minicode-skills, minicode-solo, minicode-agent-os)
- Build & CI/CD infrastructure code in this repository

### Out of Scope

- Vulnerabilities in upstream VS Code — report to [Microsoft Security Response Center](https://msrc.microsoft.com)
- Vulnerabilities in third-party npm dependencies — reported separately via npm audit
- Issues requiring physical access or social engineering

## Security Best Practices for Contributors

1. Never commit secrets — use VS Code SecretStorage or environment variables
2. Use child_process.spawn with argument arrays — never construct shell commands via string interpolation
3. Validate all file paths — guard against path traversal
4. Add timeouts and size limits to all network requests
5. Review product.json changes carefully — this file configures external API endpoints
6. Run npm audit before merging — CI will block PRs with critical vulnerabilities

## Hall of Fame

We gratefully acknowledge security researchers who have responsibly disclosed vulnerabilities. To be added upon first valid disclosure.
