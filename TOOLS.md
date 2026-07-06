# Tools Reference

Complete documentation for all 212 tools in `salesforce-metadata-mcp`.

---

## Objects & Fields

### sf_create_custom_object
Creates a new Salesforce Custom Object using the Metadata API.

**Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `fullName` | string | required | API name ending in `__c`, e.g. `Invoice__c` |
| `label` | string | required | Singular display label |
| `pluralLabel` | string | required | Plural display label |
| `description` | string | — | Optional description |
| `nameFieldLabel` | string | `"Name"` | Label for the standard Name field |
| `nameFieldType` | `Text\|AutoNumber` | `"Text"` | Name field type |
| `autoNumberFormat` | string | — | Format for AutoNumber, e.g. `INV-{0000}` |
| `deploymentStatus` | `Deployed\|InDevelopment` | `"Deployed"` | Deployment status |
| `sharingModel` | `ReadWrite\|Read\|Private\|...` | `"ReadWrite"` | OWD sharing model |
| `enableActivities` | boolean | `true` | Allow Tasks/Events |
| `enableHistory` | boolean | `false` | Enable field history tracking |
| `enableReports` | boolean | `true` | Available in Reports |
| `enableSearch` | boolean | `true` | Searchable |

**Example prompts:**
- "Create a custom object called Project__c with plural label Projects"
- "Create a Job Application object with AutoNumber name format JOB-{0000}"
- "Create a custom object called Feedback__c with Private sharing and no activities"

---

### sf_create_custom_field
Creates a new field on an existing object.

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `objectName` | string | Parent object API name |
| `fieldName` | string | Field API name ending in `__c` |
| `label` | string | Display label |
| `type` | FieldType | Text, Number, Picklist, Lookup, etc. |
| `required` | boolean | Is field required |
| `unique` | boolean | Must values be unique |
| `length` | number | For Text fields (1-255) |
| `precision` / `scale` | number | For Number/Currency fields |
| `picklistValues` | object | Required for Picklist/MultiselectPicklist |
| `referenceTo` | string | For Lookup/MasterDetail |
| `deleteConstraint` | string | For Lookup: Cascade/Restrict/SetNull |

**Example prompts:**
- "Add a Status__c picklist field to Invoice__c with values: Draft, Pending, Approved, Rejected"
- "Add an Amount__c currency field to Opportunity with 2 decimal places"
- "Add a lookup from Project__c to Account"

---

### sf_create_custom_metadata_type
Creates a Custom Metadata Type (__mdt) for storing configuration.

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `fullName` | string | API name ending in `__mdt` |
| `label` | string | Singular label |
| `pluralLabel` | string | Plural label |
| `description` | string | Optional description |
| `fields` | array | Custom fields to add |

**Example prompts:**
- "Create a Feature_Flag__mdt Custom Metadata Type with a Boolean field IsEnabled__c"
- "Create an Integration_Config__mdt type with fields for endpoint URL and API key"

---

### sf_create_apex_class
Deploys an Apex class to the org via Metadata API zip deploy.

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `className` | string | Class name (no __c) |
| `classBody` | string | Full Apex source code |
| `apiVersion` | string | API version, default `62.0` |

**Example prompts:**
- "Create an Apex class called AccountService with a method to get all active accounts"
- "Create a Batch Apex class called DataCleanupBatch that deletes records older than 2 years"
- "Create a Schedulable class called NightlyReport that generates a report email"

**Expected output:** Deploy job ID and success/failure message with any compile errors.

---

### sf_execute_anonymous_apex
Executes Apex code immediately via Tooling API.

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `apexCode` | string | Apex code to execute |

**Example prompts:**
- "Run this Apex to update all Contact email addresses to lowercase"
- "Execute: System.debug(UserInfo.getUserName());"
- "Run anonymous Apex to backfill the missing CreatedDate__c field on all Account records"

**Expected output:** Success/failure, compile errors if any, and debug log if present.

---

### sf_create_lwc
Deploys a Lightning Web Component via Metadata API.

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `componentName` | string | camelCase name, e.g. `accountCard` |
| `html` | string | Full HTML template content |
| `javascript` | string | Full JS controller content |
| `css` | string | Optional CSS |
| `targets` | array | Where to place the component |
| `isExposed` | boolean | Available in App Builder |
| `apiVersion` | string | Default `62.0` |

**Example prompts:**
- "Create an LWC called opportunityList that shows a table of open opportunities"
- "Create a contact card LWC with name, email, phone and make it available on Record Pages"
- "Create an LWC Flow Screen component for collecting address information"

---

### Agentforce Tools

> **Correct creation order:** Agent → Actions → Topics (with actions listed) → Planner. The planner (`sf_create_agent_planner`) is required — without it the agent cannot route requests to any topic.

---

### sf_create_agent
Creates an Agentforce Agent (Bot shell). Follow with actions, topics, and a planner.

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `agentName` | string | Agent API name |
| `label` | string | Display name |
| `description` | string | Agent description |
| `company` | string | Company context |
| `persona` | string | Agent persona description |
| `tone` | `Formal\|Neutral\|Casual` | Communication tone |
| `instructions` | string | System-level instructions |

**Example prompts:**
- "Create an Agentforce agent called SalesBot for helping sales reps close deals"
- "Create a customer service agent with a formal tone for handling support cases"

---

### sf_create_agent_action
Creates an Agentforce Action (GenAiFunction) linked to a Flow, Apex class, or Prompt Template. Create actions before topics — you'll need to list action names when creating topics.

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `agentName` | string | Parent agent API name |
| `topicName` | string | Intended parent topic (for reference — pass this action's name in the topic's `actions` list) |
| `actionName` | string | Action API name |
| `label` | string | Action label |
| `description` | string | What this action does |
| `type` | string | `Flow\|ApexClass\|PromptTemplate\|DataCategoryGroup\|ExternalService` |
| `reference` | string | API name of the Flow/Apex/PromptTemplate to invoke |
| `inputs` | array | `[{name, value}]` input parameter mappings |

---

### sf_create_agent_topic
Creates a Topic (GenAiPlugin) that defines what requests the agent handles. Pass the action names in `actions` to link them to this topic.

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `agentName` | string | Parent agent API name |
| `topicName` | string | Topic API name |
| `label` | string | Topic label |
| `description` | string | What this topic covers |
| `scope` | string | What kinds of requests it handles |
| `instructions` | string | Step-by-step handling instructions |
| `actions` | array | Action API names to wire into this topic |

---

### sf_create_agent_planner
**The critical wiring step.** Deploys a GenAiPlanner that connects the agent (Bot) to its topics. Without this, the agent has no routing capability and appears blank in Salesforce.

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `agentName` | string | Agent API name (must match existing Bot) |
| `label` | string | Planner label (defaults to agentName) |
| `topicNames` | array | All topic API names to wire to this agent |

**Example prompts:**
- "Wire SalesBot to its topics: OrderManagement, CaseManagement"
- "Create the planner for SalesBot linking topics OrderManagement and CaseManagement"

---

### sf_deploy_metadata
Deploys metadata components via SOAP deploy.

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `components` | array | `[{type, name}]` to deploy (optional when using `componentsXml`) |
| `componentsXml` | array | Inline XML components `[{type, name, xml}]` to deploy |
| `checkOnly` | boolean | Validate without deploying |
| `runTests` | array | Test classes to run |
| `testLevel` | string | `RunLocalTests` \| `RunAllTestsInOrg` \| `RunSpecifiedTests` \| `NoTestRun` |
| `rollbackOnError` | boolean | Rollback on any failure |
| `waitMinutes` | number | Timeout (default 10 min) |

**Example prompts:**
- "Deploy the AccountService Apex class and AccountTrigger to the org"
- "Validate the deployment of these components without making changes"
- "Deploy MyFlow and MyClass, running MyClassTest during deployment"

---

### sf_create_mcp_server
Generates a complete MCP server project on disk.

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `serverName` | string | Server package name |
| `outputDirectory` | string | Absolute path to output directory |
| `description` | string | Server description |
| `salesforceInstanceUrl` | string | Pre-configure org URL |

**Example prompts:**
- "Create a new MCP server called my-sf-integration in C:/projects/my-server"
- "Generate a Salesforce MCP server project targeting https://myorg.salesforce.com"

---

*For the complete list of all 212 tools, see [README.md](README.md).*
