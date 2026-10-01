# Security Policy

## Supported versions

Only the latest release receives security fixes.

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report privately via [GitHub Security Advisories](../../security/advisories/new) for this repository. Include:

- affected version and deployment mode (stdio / HTTP)
- steps to reproduce or a proof of concept
- impact as you understand it

You can expect an acknowledgement within 3 working days and a fix or mitigation plan within 14 days for confirmed issues. Coordinated disclosure is welcome – please give us a reasonable window before publishing details. Credit will be given in the release notes unless you prefer otherwise.

## Scope

In scope:

- the OAuth authorization server (DCR, authorize/consent, token, refresh, revocation)
- bearer token validation on `/mcp`
- handling and storage of the Medusa API key and issued tokens
- tools performing actions beyond what their description and annotations state

Out of scope:

- vulnerabilities in Medusa itself (report to [medusajs/medusa](https://github.com/medusajs/medusa/security))
- deployments that disable TLS, expose the server without a reverse proxy, or use a weak `OWNER_PASSWORD`
- actions a legitimately authorized MCP client performs with the tools it was granted
