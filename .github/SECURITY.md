# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |

## Reporting a Vulnerability

**Do not open public issues for security vulnerabilities.**

Please report security issues to the Minicode maintainers via email.

### Response Timeline
- Acknowledgment: within 72 hours
- Initial assessment: within 1 week

## Security Best Practices

1. Never commit secrets — use environment variables or secure credential storage
2. Validate all user input — especially file paths, URLs, and shell command arguments
3. Use parameterized commands — never construct shell commands with string interpolation
4. Enforce path traversal protection — validate file paths stay within intended directories
5. Set timeouts and size limits on all network requests
6. Use `vscode.OutputChannel` for logging — never log sensitive data
