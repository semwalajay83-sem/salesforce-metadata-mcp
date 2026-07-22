# salesforce-metadata-mcp

[![npm version](https://img.shields.io/npm/v/salesforce-metadata-mcp.svg)](https://npmjs.com/package/salesforce-metadata-mcp)
[![npm downloads](https://img.shields.io/npm/dm/salesforce-metadata-mcp.svg)](https://npmjs.com/package/salesforce-metadata-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-green.svg)](https://modelcontextprotocol.io)

**The only Salesforce MCP server that builds Agentforce agents, OmniStudio components, and DevOps Center pipelines** — alongside a complete daily developer loop (schema describe, Apex read, debug logs) and 219 tools total for building, configuring, and automating Salesforce orgs directly from Claude or any MCP client.

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

---

## Tools — 219 total

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
| `sf_get_debug_logs` | List recent Apex debug logs |
| `sf_get_debug_log_body` | Read the full content of a debug log |

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

---

## Documentation

- [SETUP.md](SETUP.md) — Prerequisites, authentication, Claude configuration
- [TOOLS.md](TOOLS.md) — All 219 tools with full parameter documentation
- [AGENTFORCE.md](AGENTFORCE.md) — Agentforce agent creation guide
- [APEX_LWC.md](APEX_LWC.md) — Apex and LWC development guide
- [CHANGELOG.md](CHANGELOG.md) — Version history

---

## Bugs & Feature Requests

Found a bug or want a new tool? [Open an issue](https://github.com/semwalajay83-sem/salesforce-metadata-mcp/issues/new/choose) — there are templates for bug reports and feature requests. Please include the package version and the tool name, and remove any org URLs or credentials before posting.

---

## License

MIT
