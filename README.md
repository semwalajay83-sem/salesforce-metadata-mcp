# salesforce-metadata-mcp

[![npm version](https://img.shields.io/npm/v/salesforce-metadata-mcp.svg)](https://npmjs.com/package/salesforce-metadata-mcp)
[![npm downloads](https://img.shields.io/npm/dm/salesforce-metadata-mcp.svg)](https://npmjs.com/package/salesforce-metadata-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-green.svg)](https://modelcontextprotocol.io)

**The only Salesforce MCP server that builds Agentforce agents, OmniStudio components, and DevOps Center pipelines** — alongside a complete daily developer loop (schema describe, Apex read, debug logs) and 228 tools total for building, configuring, and automating Salesforce orgs directly from Claude or any MCP client.

---

## Quick Start

```bash
npx -y salesforce-metadata-mcp
```

Or install globally:

```bash
npm install -g salesforce-metadata-mcp
salesforce-metadata-mcp
```

---

## Configuration (Claude Desktop / Claude Code)

Add to your MCP configuration (`claude_desktop_config.json` or `.claude/settings.json`):

```json
{
  "mcpServers": {
    "salesforce": {
      "command": "npx",
      "args": ["salesforce-metadata-mcp"],
      "env": {
        "SF_INSTANCE_URL": "https://your-org.salesforce.com",
        "SF_ACCESS_TOKEN": "your_access_token"
      }
    }
  }
}
```

See [SETUP.md](SETUP.md) for all authentication methods and detailed setup instructions.

### One-click install (Claude Desktop)

Download `salesforce-metadata-mcp-<version>.mcpb` from the [latest release](https://github.com/semwalajay83-sem/salesforce-metadata-mcp/releases/latest), then drag it into **Claude Desktop → Settings → Extensions**. It prompts for your org URL and credentials — no JSON editing.

The bundle resolves the server from npm at launch rather than embedding a copy, so it always runs the current published version and never needs re-downloading after an upgrade.

### Docker

```bash
docker build -t salesforce-metadata-mcp .
docker run -i --rm \
  -e SF_INSTANCE_URL="https://your-org.my.salesforce.com" \
  -e SF_ACCESS_TOKEN="your_access_token" \
  salesforce-metadata-mcp
```

The image builds from source, runs as a non-root user, and ships production dependencies only. Because this server speaks MCP over stdio, `-i` is required — the container is driven by its client, not run as a background service. `SF_ALIAS` will not work in a container: the Salesforce CLI's login flow needs a browser, so use token, JWT, refresh-token, or client-credentials variables instead.

---

## Toolsets — loading 228 tools without burning your context

All 228 tools are always available. Most are not loaded into the model's context until something asks for them.

Listing every tool up front costs roughly **98,000 tokens** — about half a 200k context window, spent
before you type anything, whether or not the session ever touches OmniStudio or DevOps Center. A
228-candidate tool list also makes the model measurably worse at picking the right tool. So the server
starts with a small core loaded and pulls in the rest on demand:

| Startup | Tools listed | Approx. tokens |
|---------|-------------:|---------------:|
| Default (`core,metadata`) | 18 | **~9,400** |
| After loading two more toolsets | 41 | ~20,300 |
| `SF_TOOLSETS=all` | 231 | ~98,600 |

The default covers what nearly every session needs: describe/list objects, SOQL query,
deploy/retrieve/delete metadata, deploy status, and core schema creation (objects, fields, formula
fields, picklist values, validation rules, approval processes).

Three tools are always present and make everything else reachable:

- **`sf_find_tool`** — search all 228 tools by name and load whatever contains the matches, in one
  call. Ask for *"create an omniscript"* and it finds the tools, loads `omnistudio`, and they are
  callable immediately. This is usually all you or the model needs.
- **`sf_load_toolset`** — load named toolsets explicitly.
- **`sf_list_toolsets`** — browse all toolsets, their tool counts, and what is loaded.

In practice you don't manage this by hand: ask for what you want, and the model loads what it needs.

To restore the previous behaviour of loading everything at startup, set `SF_TOOLSETS=all`. To start
with only the three meta-tools, set `SF_TOOLSETS=none`. To pick your own core, pass a list:

```json
{ "env": { "SF_TOOLSETS": "metadata,objects,automation,security" } }
```

Available toolsets: `core`, `metadata`, `objects`, `data`, `flows`, `automation`, `security`, `apex`,
`lwc`, `ui`, `pages`, `actions`, `agentforce`, `omnistudio`, `omnichannel`, `devops`, `deployment`,
`integrations`, `identity`, `reports`, `experience`, `admin`, `monitoring`, `audit`, `einstein`,
`knowledge`, `cpq`, `sandbox`, `streaming`, `visualforce`, `aura`, `comms`, `mcp`, `i18n`.

Flow tools live in their own `flows` toolset because `sf_create_flow` carries the full Flow element
schema — 15,266 bytes (~4,126 tokens) on its own, the largest tool definition in the server. Keeping
it out of the default means sessions that never build a Flow never pay for it, while sessions that do
still get the complete validated schema.

---

## Tools — 228 total

Highlights below; see [TOOLS.md](TOOLS.md) for the complete reference with parameters and example prompts.

### Objects & Fields
| Tool | Description |
|------|-------------|
| `sf_create_custom_object` | Create a custom object with all settings |
| `sf_create_custom_field` | Create a field on any object (all types) |
| `sf_create_formula_field` | Create formula fields with full formula language support |
| `sf_add_picklist_values` | Add values to existing picklist fields |
| `sf_create_custom_metadata_type` | Create a Custom Metadata Type (__mdt) |
| `sf_create_custom_metadata_record` | Create records for a Custom Metadata Type |
| `sf_create_custom_label` | Create or update Custom Labels |
| `sf_create_custom_setting` | Create Hierarchy or List Custom Settings |
| `sf_create_global_value_set` | Create shared picklist usable across objects |
| `sf_create_record_type` | Create Record Types with picklist overrides |
| `sf_create_business_process` | Create Business Processes for Opp/Lead/Case |
| `sf_create_page_layout` | Create Page Layouts with sections and fields |
| `sf_create_sharing_rule` | Create criteria or ownership sharing rules |
| `sf_create_field_dependency` | Create controlling/dependent picklist dependency |
| `sf_describe_object` | Read an object's full schema — fields, types, picklist values, child relationships, record types |
| `sf_list_objects` | **Find objects by partial name or label** — the discovery step before `sf_describe_object` |
| `sf_get_metadata_dependencies` | **Impact analysis: what references this component, and does the field hold data?** Read-only |
| `sf_update_custom_object` | Update object-level properties, risk-classified with a confirmation gate |
| `sf_update_custom_field` | Update a field's definition, risk-classified — destructive changes report impact before applying |

### Automation
| Tool | Description |
|------|-------------|
| `sf_create_flow` | Create any Flow type — Assignment, Decision, GetRecords, CreateRecords (with field values), DeleteRecords, Loop |
| `sf_create_approval_process` | Create multi-step approval processes |
| `sf_create_validation_rule` | Create data validation rules |
| `sf_create_workflow_field_update` | Create workflow field update actions |
| `sf_create_email_alert` | Create workflow email alert actions |
| `sf_create_platform_event` | Create Platform Event objects |
| `sf_create_assignment_rule` | Create Lead/Case assignment rules |
| `sf_create_escalation_rule` | Create Case escalation rules |
| `sf_create_auto_response_rule` | Create Web-to-Lead/Case auto-response rules |
| `sf_create_matching_rule` | Create duplicate matching rules |
| `sf_create_duplicate_rule` | Create duplicate detection rules |
| `sf_create_apex_email_service` | Create inbound Apex email services |
| `sf_create_scheduled_job` | Schedule an Apex class via cron |

### Security & Access
| Tool | Description |
|------|-------------|
| `sf_create_permission_set` | Create Permission Sets with all permissions |
| `sf_create_role` | Create roles in the role hierarchy |
| `sf_create_queue` | Create queues with members and objects |
| `sf_create_named_credential` | Create Named Credentials for callouts |
| `sf_get_field_permissions` | Audit current field-level security grants across Profiles and Permission Sets |

### UI & Experience
| Tool | Description |
|------|-------------|
| `sf_create_lightning_app` | Create Lightning Apps with nav/utility bars |
| `sf_create_tab` | Create Custom Tabs for objects |
| `sf_create_compact_layout` | Create Compact Layouts (highlights panel) |
| `sf_create_list_view` | Create List Views with filters and columns |
| `sf_create_email_template` | Create HTML/text email templates |
| `sf_create_static_resource` | Create Static Resources from text content |
| `sf_create_custom_notification_type` | Create Custom Notification Types |
| `sf_create_report_type` | Create Custom Report Types |
| `sf_create_dashboard` | Create Dashboards with components |

### Apex Development
| Tool | Description |
|------|-------------|
| `sf_create_apex_class` | Deploy any Apex class to the org |
| `sf_create_apex_trigger` | Deploy an Apex trigger on any object |
| `sf_create_apex_test_class` | Deploy test classes, optionally run tests |
| `sf_run_apex_tests` | Run test classes and get pass/fail results |
| `sf_execute_anonymous_apex` | Execute anonymous Apex and see output |
| `sf_get_apex_class` | Read the source of an existing Apex class |
| `sf_get_apex_trigger` | Read the source of an existing Apex trigger |
| `sf_enable_debug_logs` | Turn on Apex debug logging for a user (TraceFlag) |
| `sf_disable_debug_logs` | Turn Apex debug logging back off (deletes active TraceFlags) |
| `sf_get_debug_logs` | List recent Apex debug logs |
| `sf_get_debug_log_body` | Read the full content of a debug log |
| `sf_scan_apex_antipatterns` | Lightweight heuristic scan for SOQL/DML-in-loop, hardcoded IDs, debug statements |
| `sf_run_code_scanner` | Multi-engine static analysis (PMD, SFGE SOQL-injection data-flow, RetireJS, ESLint) via Salesforce Code Analyzer |

### LWC Development
| Tool | Description |
|------|-------------|
| `sf_create_lwc` | Deploy a full LWC with HTML, JS, CSS |
| `sf_update_lwc` | Update an existing LWC component |

### Experience Cloud
| Tool | Description |
|------|-------------|
| `sf_create_experience_site` | Create Experience Cloud sites |
| `sf_create_experience_page` | Create pages within Experience sites |

### Agentforce
| Tool | Description |
|------|-------------|
| `sf_create_agent` | Create Agentforce Agent (Bot shell) |
| `sf_create_agent_action` | Create Agent Actions (GenAiFunction) linked to Flows/Apex |
| `sf_create_agent_topic` | Create Agent Topics (GenAiPlugin) with actions wired in |
| `sf_create_agent_planner` | Wire agent to its topics (GenAiPlanner) — required for routing |

### External Integrations
| Tool | Description |
|------|-------------|
| `sf_create_connected_app` | Create OAuth Connected Apps |
| `sf_create_external_client_app` | Create External Client Apps (OAuth) — Salesforce's newer replacement for Connected Apps; Client Credentials Flow (incl. Run As user) is API-settable here, unlike Connected Apps |
| `sf_create_external_data_source` | Create External Data Sources for Connect |
| `sf_create_external_object` | Create External Objects (__x) |
| `sf_create_remote_site_setting` | Whitelist external URLs for callouts |
| `sf_create_csp_setting` | Create CSP trusted sites for LWC |

### Change Sets & Deployment
| Tool | Description |
|------|-------------|
| `sf_create_outbound_change_set` | Create Outbound Change Sets |
| `sf_add_to_change_set` | Add components to a change set |
| `sf_deploy_metadata` | Deploy metadata via Metadata API (supports `testLevel`, inline XML) |
| `sf_check_deploy_status` | Check deployment job status |
| `sf_retrieve_metadata` | Retrieve metadata from the org |
| `sf_delete_metadata` | Permanently delete metadata components (CustomObject, CustomField, Flow, GenAiFunction, Bot, etc.) |

### MCP Server Management
| Tool | Description |
|------|-------------|
| `sf_create_mcp_server` | Generate a new MCP server project on disk |
| `sf_create_mcp_tool` | Add a new tool to an existing MCP server |
| `sf_list_mcp_tools` | List all tools in an MCP server project |

---

## Example Prompts

**Build a complete object:**
> "Create a custom object called Project__c with fields: Name (text), Status__c (picklist: Planning/Active/Complete), Budget__c (currency), then add a validation rule requiring Budget when Status is Active."

**Deploy Apex:**
> "Create an Apex class called OpportunityService that queries all Opps with Amount > 100000. Then create a test class for it."

**Create a flow:**
> "Create a record-triggered flow on Opportunity that fires after save when Stage = Closed Won. Send an email alert to the owner and create a follow-up Task due in 30 days."

**Set up an LWC:**
> "Create a Lightning Web Component called accountSummary that displays account name, industry, and annual revenue. Make it available on Record Pages."

**Agentforce setup:**
> "Create an Agentforce agent called SalesAssistant. Then create a GetOrders action linked to the Get_Account_Orders flow. Then create an OrderManagement topic with actions: [GetOrders]. Finally wire SalesAssistant to topic OrderManagement."

---

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `SF_INSTANCE_URL` | Your org URL (e.g. https://org.salesforce.com) | Always |
| `SF_CLIENT_ID` | Connected App client ID | For OAuth |
| `SF_CLIENT_SECRET` | Connected App client secret | For OAuth |
| `SF_REFRESH_TOKEN` | OAuth refresh token | For OAuth |
| `SF_ALIAS` | Salesforce CLI org alias | For CLI |
| `SF_ACCESS_TOKEN` | Static access token (expires ~1hr) | For static |
| `PORT` | HTTP server port (default: 3000) | For HTTP mode |
| `TRANSPORT` | `stdio` or `http` (default: stdio) | Optional |
| `SF_TOOLSETS` | Toolsets to load at startup: `all`, `none`, or a comma-separated list (default: `core,metadata`) | Optional |
| `SF_TOOLSETS_VERBOSE` | Set to `1` to print the full toolset list to stderr on startup | Optional |
| `SF_PRODUCTION_GUARD` | `destructive` (default), `strict`, or `off` — see below | Optional |

---

## Production write guard

This server hands an LLM a Salesforce credential, and the LLM decides what to do with it. Any text
the model reads on the way — a case comment, a field description, a retrieved `.flow` file, an
email body — can carry an instruction, and nothing downstream can tell it apart from one you typed.

So against a **production org**, nine tools are refused by default:

| Blocked on production | Why |
|---|---|
| `sf_delete_metadata` | Destroys metadata and every record in it |
| `sf_delete_record`, `sf_bulk_delete_records` | Destroy data |
| `sf_execute_anonymous_apex` | Arbitrary code that leaves no artifact behind |
| `sf_uninstall_package` | Removes a managed package and its data |
| `sf_create_user`, `sf_update_user` | Privilege escalation |
| `sf_reset_user_password`, `sf_freeze_user` | Account takeover / lockout |

**Metadata creation is not affected.** All 137 `sf_create_*` tools, `sf_deploy_metadata` and
`sf_retrieve_metadata` work against production exactly as before — authoring metadata by natural
language is the point of this package, and a guard that taxed it would just get switched off.

Apex authoring (`sf_create_apex_class`, `sf_create_apex_trigger`) is also **not** blocked, even
though a trigger runs on every DML. The line drawn is auditability: created Apex is metadata — it
has a name, an author and a deploy record, and can be found and removed. `sf_execute_anonymous_apex`
leaves nothing to find, which is why that one is blocked.

An org counts as production only when it is **not** a sandbox, **not** a Developer Edition org, and
**not** on a trial/scratch expiry. Sandboxes, dev orgs and scratch orgs are never gated.

```jsonc
{ "env": { "SF_PRODUCTION_GUARD": "strict" } }   // refuse ALL writes on production
{ "env": { "SF_PRODUCTION_GUARD": "off" } }      // no guard at all
```

The guard is a hard refusal, not a confirmation prompt: a prompt the calling agent can approve by
itself is not a control, and this server is often run with client permissions bypassed. Only the
environment variable lifts it.

---

## Documentation

- [SETUP.md](SETUP.md) — Prerequisites, authentication, Claude configuration
- [TOOLS.md](TOOLS.md) — All 228 tools with full parameter documentation
- [AGENTFORCE.md](AGENTFORCE.md) — Agentforce agent creation guide
- [APEX_LWC.md](APEX_LWC.md) — Apex and LWC development guide
- [CHANGELOG.md](CHANGELOG.md) — Version history

---

## Bugs & Feature Requests

Found a bug or want a new tool? [Open an issue](https://github.com/semwalajay83-sem/salesforce-metadata-mcp/issues/new/choose) — there are templates for bug reports and feature requests. Please include the package version and the tool name, and remove any org URLs or credentials before posting.

---

## License

MIT
