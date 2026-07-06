# Get Started in 5 Minutes

**salesforce-metadata-mcp** lets you build and configure Salesforce orgs by talking to Claude.  
60+ tools — create objects, fields, flows, Apex classes, LWC, Agentforce agents, and more — all from natural language.

**No code required. No Salesforce CLI required.**

---

## Step 1 — Get a Salesforce Org

If you don't have one, grab a free Developer Edition:  
→ https://developer.salesforce.com/signup

---

## Step 2 — Get Claude Desktop

Download Claude Desktop (free):  
→ https://claude.ai/download

---

## Step 3 — Get Your Salesforce Access Token

In a browser, go to your org and open the Developer Console (Setup → Developer Console).  
Or run this if you have the Salesforce CLI installed:

```bash
sf org display --target-org YOUR_ORG_ALIAS --json
```

Copy the `accessToken` value. *(Tokens expire after ~1 hour. For a permanent setup, see [SETUP.md](SETUP.md) for OAuth refresh tokens.)*

---

## Step 4 — Configure Claude Desktop

Open this file in a text editor:

- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

Paste this (replace the two placeholder values):

```json
{
  "mcpServers": {
    "salesforce": {
      "command": "npx",
      "args": ["-y", "salesforce-metadata-mcp"],
      "env": {
        "SF_INSTANCE_URL": "https://YOUR-ORG.my.salesforce.com",
        "SF_ACCESS_TOKEN": "00D...your_token_here"
      }
    }
  }
}
```

Save the file and **restart Claude Desktop**.

---

## Step 5 — Start Building

Open a new Claude conversation. You should see a hammer icon (🔨) indicating MCP tools are active.

Try these prompts to verify it works:

```
Create a custom object called Project__c with a Description field and Status picklist
```

```
Create an Apex class called HelloWorld that returns a greeting string
```

```
Create an LWC called accountBanner that shows the account name in a blue header
```

That's it. Claude will call the Salesforce Metadata API and deploy directly to your org.

---

## What You Can Build

| Category | Examples |
|----------|---------|
| **Objects & Fields** | Custom objects, picklists, lookups, formula fields |
| **Automation** | Flows, approval processes, validation rules, workflow rules |
| **Apex** | Classes, triggers, test classes, batch jobs, schedulable jobs |
| **LWC** | Lightning Web Components for record pages, app pages, flows |
| **Security** | Permission sets, roles, queues, named credentials |
| **Agentforce** | Einstein Copilot agents, topics, and actions |
| **Deployment** | Deploy/retrieve metadata, change sets, deploy status |
| **Integrations** | Connected apps, external data sources, remote site settings |

---

## Troubleshooting

| Error | Fix |
|-------|-----|
| `INVALID_SESSION_ID` | Access token expired — get a new one (Step 3) or switch to OAuth (see SETUP.md) |
| `INSUFFICIENT_ACCESS` | Your user needs System Administrator profile |
| `Missing SF_INSTANCE_URL` | Check your `claude_desktop_config.json` — both env vars must be set |
| Hammer icon not showing | Restart Claude Desktop after editing the config file |

---

## Links

- **npm:** https://www.npmjs.com/package/salesforce-metadata-mcp
- **Full tool list:** [TOOLS.md](TOOLS.md)
- **OAuth setup (permanent auth):** [SETUP.md](SETUP.md)
- **Apex & LWC guide:** [APEX_LWC.md](APEX_LWC.md)
- **Agentforce guide:** [AGENTFORCE.md](AGENTFORCE.md)
