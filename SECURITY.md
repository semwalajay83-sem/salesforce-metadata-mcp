# Security Policy

## Security Model

`salesforce-metadata-mcp` is a local MCP server. Understanding what it does and does not do:

**Credentials never leave your machine.** All Salesforce API calls are made directly from your local process to your Salesforce org. No credentials or metadata pass through Anthropic's servers or any third-party service.

**Claude sees tool results, not credentials.** The MCP protocol sends structured tool results (success/failure messages, component names) to Claude. Access tokens are never included in tool output.

**Zero outbound connections except Salesforce.** The package makes HTTP requests only to the `SF_INSTANCE_URL` you configure. There are no analytics, telemetry, or third-party API calls.

---

## Dependencies

This package intentionally uses a minimal dependency footprint:

| Package | Purpose | Why included |
|---------|---------|-------------|
| `@modelcontextprotocol/sdk` | MCP transport layer | Required to implement the MCP protocol |
| `jszip` | In-memory zip creation | Required for Metadata API zip-based deployment of Apex/LWC |
| `zod` | Input schema validation | Runtime type safety and input sanitization for all tool parameters |

**No HTTP client library is used.** All HTTP requests use the Node.js 18+ built-in `fetch` API. No `axios`, `got`, `node-fetch`, or similar library is included.

**No web framework is used.** The optional HTTP transport uses the Node.js built-in `http` module. No `express`, `fastify`, or similar library is included.

---

## Shell Access

This package optionally invokes the Salesforce CLI (`sf`) via `child_process.execSync` when the `SF_ALIAS` environment variable is set. This is the only shell access in the codebase.

**Protections in place:**

1. **Input validation:** The alias value is validated against the regex `^[A-Za-z0-9_-]+$` before being passed to `execSync`. Any value containing spaces, semicolons, pipes, quotes, or other shell metacharacters is rejected with a clear error.

2. **Minimal PATH:** The child process is spawned with `env: { PATH: process.env.PATH }` — no additional environment is inherited.

3. **Timeout:** The `execSync` call has a 30-second timeout.

4. **Clear opt-in:** This code path is only reached when `SF_ALIAS` is explicitly configured by the operator.

**To avoid shell access entirely:** Use OAuth refresh tokens (`SF_CLIENT_ID` + `SF_CLIENT_SECRET` + `SF_REFRESH_TOKEN`) or a static access token (`SF_ACCESS_TOKEN`). Neither of these strategies spawns any child process.

---

## Input Validation

All tool inputs are validated by Zod schemas before being used:

- **API names** are validated against Salesforce naming conventions (letters, numbers, underscores, appropriate suffixes like `__c`, `__mdt`, `__e`).
- **Large-content fields** (Apex code, HTML, JavaScript, CSS) have maximum length limits to prevent memory exhaustion.
- **URL fields** are validated as proper URLs.
- **Environment variables** are validated for maximum length: `SF_INSTANCE_URL` (255 chars), `SF_ALIAS` (50 chars), `SF_ACCESS_TOKEN` (4096 chars).
- **`SF_INSTANCE_URL` must be HTTPS.** HTTP URLs are rejected.

---

## Error Handling

- Error messages are sanitized before being returned to Claude. File system paths and stack traces are stripped.
- Access tokens are never included in error messages or logged to stderr.
- The `sanitizeError()` and `redactSensitive()` helpers are applied at all error boundaries.

---

## Supported Versions

| Version | Status |
|---------|--------|
| 2.12.x | ✅ Supported — current npm `latest` |
| 2.11.2 | ✅ Contains all security fixes |
| 2.11.1 | ⚠️ Has the code fixes, but ships 5 production-dependency advisories resolved in 2.11.2 — upgrade |
| **≤ 2.8.7** | ❌ **Deprecated on npm (2026-08-26) — command injection (RCE), SOQL injection, credential leak** |
| 1.x | ❌ No longer supported |

### Deprecated versions — 2026-08-26

Every version **2.0.0 through 2.8.7** was deprecated on npm and now emits a warning on install.

The security audit in **v2.8.8** fixed a confirmed command injection (RCE), a SOQL injection, a
credential leak and a generated-code injection. **v2.8.8, v2.8.9, v2.9.0, v2.10.0 and v2.11.0 were
never published to npm**, so the first npm release carrying those fixes is **v2.11.1**. Anyone on
`2.8.7` or below — including the version that was npm `latest` at the time — is running unfixed code.

If you are pinned to any version at or below 2.8.7, upgrade:

```
npm install salesforce-metadata-mcp@latest
```

Note that pinning to an exact old version bypasses `latest` entirely; check your lockfile, Dockerfile
or MCP client config for a hardcoded version string.

---

## Permissions Required

The Salesforce user account needs:

| Permission | Why |
|-----------|-----|
| Modify All Data / System Administrator | Required to create and deploy metadata via the Metadata API |
| Author Apex | Required for Apex class and trigger deployment |
| Customize Application | Required for custom objects, fields, and other metadata types |
| Manage Users | Required if creating permission sets and roles |

The minimum viable approach is a System Administrator profile in a sandbox or Developer Edition org. **Do not use production org System Administrator credentials unless you understand what you are deploying.**

---

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Report security issues by email to: **semwalajay@hotmail.com**

Include:
- A description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested mitigations

You will receive an acknowledgment within 48 hours and a resolution timeline within 7 days for confirmed vulnerabilities.
