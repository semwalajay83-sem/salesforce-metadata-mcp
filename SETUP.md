# Setup Guide

Complete prerequisites and configuration for `salesforce-metadata-mcp`.

---

## Prerequisites

### 1. Node.js 18+

```bash
node --version  # must be 18.0.0 or higher
```

Download from [nodejs.org](https://nodejs.org) if needed.

### 2. Salesforce Org

You need a Salesforce org (Developer Edition, Sandbox, or Production). Free Developer Edition orgs: [developer.salesforce.com/signup](https://developer.salesforce.com/signup).

---

## Authentication Methods

The server tries these in order:

### Method 1: OAuth Refresh Token (Recommended for Production)

**Step 1: Create a Connected App in Salesforce**

1. Go to **Setup → App Manager → New Connected App**
2. Fill in: Connected App Name, API Name, Contact Email
3. Under **OAuth Settings**, check **Enable OAuth Settings**
4. Set Callback URL: `https://login.salesforce.com/services/oauth2/success`
5. Add scopes: `Full Access (full)`, `Perform requests at any time (refresh_token, offline_access)`
6. Save. Wait 2-10 minutes for the app to activate.
7. Click **Manage Consumer Details** to get your **Consumer Key** (client_id) and **Consumer Secret**

**Step 2: Get your Refresh Token**

Using the Salesforce CLI:
```bash
sf org login web --client-id YOUR_CONSUMER_KEY --instance-url https://login.salesforce.com
sf org display --target-org YOUR_USERNAME --json
# Copy the refreshToken value
```

**Step 3: Configure environment variables**
```env
SF_INSTANCE_URL=https://yourorg.my.salesforce.com
SF_CLIENT_ID=3MVG9...your_consumer_key...
SF_CLIENT_SECRET=your_consumer_secret
SF_REFRESH_TOKEN=5Aep...your_refresh_token...
```

### Method 2: Salesforce CLI Alias

**Step 1: Install Salesforce CLI**
```bash
npm install -g @salesforce/cli
sf --version
```

**Step 2: Authenticate**
```bash
sf org login web --instance-url https://login.salesforce.com --alias myOrg
```

**Step 3: Configure**
```env
SF_INSTANCE_URL=https://yourorg.my.salesforce.com
SF_ALIAS=myOrg
```

> **Note:** The alias must contain only letters, numbers, hyphens, and underscores (e.g. `myorg`, `acme3`, `dev-org`). Special characters or spaces will be rejected for security reasons.

### Method 3: Static Access Token (Dev/Testing Only)

Access tokens expire after ~1 hour. Only use for quick testing.

**Get an access token:**
```bash
sf org display --target-org myOrg --json
# Look for "accessToken" in the output
```

**Configure:**
```env
SF_INSTANCE_URL=https://yourorg.my.salesforce.com
SF_ACCESS_TOKEN=00D...your_access_token...
```

---

## Claude Desktop Configuration

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

### Using OAuth (recommended)
```json
{
  "mcpServers": {
    "salesforce": {
      "command": "npx",
      "args": ["-y", "salesforce-metadata-mcp"],
      "env": {
        "SF_INSTANCE_URL": "https://yourorg.my.salesforce.com",
        "SF_CLIENT_ID": "your_consumer_key",
        "SF_CLIENT_SECRET": "your_consumer_secret",
        "SF_REFRESH_TOKEN": "your_refresh_token"
      }
    }
  }
}
```

### Using CLI alias
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

### Using a local build
```json
{
  "mcpServers": {
    "salesforce": {
      "command": "node",
      "args": ["/path/to/salesforce-metadata-mcp-server/dist/index.js"],
      "env": {
        "SF_INSTANCE_URL": "https://yourorg.my.salesforce.com",
        "SF_ACCESS_TOKEN": "your_token"
      }
    }
  }
}
```

---

## Claude Code Configuration

Add to `.claude/settings.json` in your project, or `~/.claude/settings.json` for global:

```json
{
  "mcpServers": {
    "salesforce": {
      "command": "npx",
      "args": ["-y", "salesforce-metadata-mcp"],
      "env": {
        "SF_INSTANCE_URL": "https://yourorg.my.salesforce.com",
        "SF_CLIENT_ID": "your_consumer_key",
        "SF_CLIENT_SECRET": "your_consumer_secret",
        "SF_REFRESH_TOKEN": "your_refresh_token"
      }
    }
  }
}
```

---

## HTTP Transport Mode

For server deployments or multi-user scenarios:

```env
TRANSPORT=http
PORT=3000
```

Start the server:
```bash
node dist/index.js
```

The server will listen at `http://localhost:3000/mcp`.

---

## Troubleshooting

**"Missing SF_INSTANCE_URL environment variable"**
→ Make sure `SF_INSTANCE_URL` is set in your MCP configuration env block.

**"No access token returned from SF CLI"**
→ Run `sf org login web` and verify the alias is correct.

**"INVALID_SESSION_ID"**
→ Your access token has expired. Use OAuth refresh token method for automatic renewal.

**"INSUFFICIENT_ACCESS"**
→ The authenticated user needs sufficient permissions. Try a System Administrator profile.

**Metadata API errors**
→ The org must have Metadata API enabled (all Developer/Enterprise/Unlimited editions have it).

**"Cannot deploy Apex to production without test coverage"**
→ Run `sf_run_apex_tests` first to verify coverage, then deploy with `runTests` specified.

**"Error: SF_ALIAS contains invalid characters"**
→ The alias contains spaces or special characters that are blocked for security. Rename it to use only letters, numbers, hyphens, and underscores:
```bash
sf org login web --alias valid-alias-name
```
Or switch to the OAuth refresh token method (Method 1) which does not use a CLI alias at all.
