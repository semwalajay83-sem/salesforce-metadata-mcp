# Setup — salesforce-metadata-mcp

Requires Node.js 18+ and a Salesforce org (free Developer Edition:
https://developer.salesforce.com/signup).

## Claude Code

```bash
claude mcp add salesforce -e SF_INSTANCE_URL=https://yourorg.my.salesforce.com -e SF_ALIAS=myOrg -- npx -y salesforce-metadata-mcp
```

## Claude Desktop, Cursor and other MCP clients

Add to the client's MCP config (`claude_desktop_config.json`, `.cursor/mcp.json`, etc.):

```json
{
  "mcpServers": {
    "salesforce": {
      "command": "npx",
      "args": ["-y", "salesforce-metadata-mcp"],
      "env": {
        "SF_INSTANCE_URL": "https://yourorg.my.salesforce.com",
        "SF_ALIAS": "myOrg"
      }
    }
  }
}
```

## Authentication (pick one)

| Method | Env vars | Best for |
|---|---|---|
| Salesforce CLI alias | `SF_ALIAS` (after `sf org login web --alias myOrg`) | Local use, easiest |
| JWT bearer (no browser, auto-refresh) | `SF_JWT_CLIENT_ID`, `SF_JWT_KEY_FILE`, `SF_JWT_USERNAME` | Servers, CI |
| OAuth refresh token | `SF_CLIENT_ID`, `SF_CLIENT_SECRET`, `SF_REFRESH_TOKEN` | Long-running setups |
| Static access token | `SF_ACCESS_TOKEN` | Quick tests only — expires in ~1 hour |

All methods also need `SF_INSTANCE_URL`.

## Optional settings

- `SF_TOOLSETS` — comma-separated toolsets to load at start (default `core,metadata`).
- `SF_PRODUCTION_GUARD` — `destructive` (default: blocks deletes, anonymous Apex and user changes
  on production), `strict` (production is read-only), or `off`.

Full docs: https://github.com/semwalajay83-sem/salesforce-metadata-mcp
