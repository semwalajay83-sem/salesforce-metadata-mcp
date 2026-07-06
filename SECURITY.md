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

| Version | Supported |
|---------|-----------|
| 2.1.x   | ✅ Current |
| 2.0.x   | ⚠️ Upgrade recommended |
| 1.x     | ❌ No longer supported |

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
