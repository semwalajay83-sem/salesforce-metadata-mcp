# Changelog

## [2.6.7] - 2026-07-06

### Docs-only release (no functional changes)

- npm README refreshed: the "Tools (60+)" heading above the tool list now correctly says 212 (the fix landed in git after 2.6.6 was published, so the npm page kept showing the stale heading)
- npm package description shortened below 250 characters so npm search no longer truncates it mid-word
- Added `.github/FUNDING.yml` for the GitHub Sponsors button

## [2.6.6] - 2026-07-06

### Public release housekeeping (no functional changes)

- GitHub repository is now public: https://github.com/semwalajay83-sem/salesforce-metadata-mcp
- package.json: added `repository`, `homepage`, `bugs`, and `mcpName` fields; fixed `funding` URL
- Corrected tool count everywhere to 212 (verified against registered tools); npm description, README, TOOLS.md, QUICKSTART.md updated
- README badges now track the live npm version and downloads
- Added `server.json` for the official MCP registry
- Removed hardcoded org URLs and credentials from test scripts (now read from `.env.local` / environment)

## [2.6.5] - 2026-06-17

### Fix — Agent creation stops after shell created (topic/action/planner never called)

Root cause: tool success messages said "Next steps:" which Claude Desktop interpreted as informational output to display to the user, causing it to stop and report back instead of continuing.

- `sf_create_agent` success message: now says "THE AGENT IS NOT FUNCTIONAL YET — do not report success to the user. REQUIRED NEXT ACTIONS (call these tools now, in order, without stopping)..."
- `sf_create_agent_action` success message: now says "DO NOT STOP — proceed immediately"
- `sf_create_agent_topic` success message: now says "DO NOT STOP — call sf_create_agent_planner now"
- All four tool descriptions updated to number each step (step 1 of 4, step 2 of 4, etc.) and say "do not stop between steps" and "do not ask the user for confirmation between steps"
- `sf_create_agent` description now explicitly lists flow/apex creation as step 0 (prerequisite before any agent tools)

## [2.6.4] - 2026-06-17

### Bug Fixes — Agentforce end-to-end natural language agent creation

Six bugs that would silently break any natural-language Agentforce session:

**CRITICAL — `sf_create_flow` ignored `status` parameter, always deployed as Draft**
- `buildFlowDeployXml` was called with hardcoded `status: "Draft"`, so `params.status` was thrown away
- Agents can only invoke Active flows — every flow created for an agent action was silently unusable
- Fix: pass `params.status ?? "Draft"` through to the XML builder (`tools/metadata.ts` line 165)

**CRITICAL — `GenAiFunction` XML was missing required `<developerName>` element**
- Salesforce requires `developerName` in GenAiFunction metadata — without it the action has no stable API name
- The agent topic references actions by their developer name; this mismatch could cause topic deploy to fail or action to be unreachable
- Fix: added `<developerName>${actionName}</developerName>` to the GenAiFunction XML block

**CRITICAL — `sf_create_apex_class` gave no warning about `@InvocableMethod` requirement**
- Users creating an Apex class for an agent action would deploy a valid class with no invocable entry point
- The class deploys successfully but the agent silently fails to invoke it at runtime
- Fix: added explicit `@InvocableMethod` requirement and example to the tool description

**HIGH — `fieldUpdates.formula` used `<elementReference>` instead of `<formula>`**
- Formula expressions like `TODAY()` were wrapped in `<elementReference>`, causing Salesforce to look for a flow variable named `TODAY()` instead of evaluating the formula
- Fixed in both SOAP path (`buildFlowXml`) and ZIP path (`buildFlowDeployXml`)

**HIGH — `Wait` and `PlatformEvent` advertised as flow element types but produce broken XML**
- Neither type had a handler in the flow XML builder — they were silently dropped, leaving the start connector pointing to a non-existent element and causing deployment failure
- Fix: removed both from `FlowElementSchema` type enum and from the tool description

**MEDIUM — `CreateAgentTopicSchema.instructions` declared as `string` but handler expected `string | string[]`**
- The schema/handler type mismatch meant array instructions could never be passed despite the handler supporting them
- Fix: changed schema to `z.union([z.string(), z.array(z.string())])` to match handler intent

## [2.6.3] - 2026-06-17

### Improvements — Natural language robustness for Agentforce tools

All schema descriptions and tool descriptions hardened so Claude Desktop users typing in plain English cannot silently misconfigure agents:

- **`sf_create_flow` `flowType`**: Now explicitly warns that Agentforce agents can **only** invoke `AutoLaunchedFlow` — Screen flows are invisible to agents
- **`sf_create_flow` `status`**: Now warns that Draft flows are invisible to agents and cause silent failures — set `Active` for agent-backing flows
- **`CreateAgentTopicSchema.actions`**: Marked CRITICAL — warns that omitting this field silently creates a topic with no executable actions
- **`CreateAgentTopicSchema.agentName`**: Clarified as informational only — actual wiring happens in `sf_create_agent_planner`
- **`CreateAgentActionSchema.topicName`**: Clarified as informational only — must still pass action name in topic's `actions` array
- **`CreateAgentActionSchema.reference`**: Now shows format per type (Flow API name, Apex class name, etc.)
- **`CreateAgentActionSchema.type`**: Now specifies constraints (Flow must be Active AutoLaunchedFlow, ApexClass needs @InvocableMethod)
- **`CreateAgentPlannerSchema.topicNames`**: Now warns this is a **full replace** — omitting a topic removes it from the agent
- **`CreateAgentPlannerSchema.agentName`**: Added no-underscore regex matching Bot API name constraint

## [2.6.2] - 2026-06-17

### Bug Fixes — Exhaustive full-codebase audit (25 bugs fixed in one pass)

#### Critical

**C1 — `createScheduledFlow`: hardcoded `mySubflow` connector broke every scheduled flow**
- Each `scheduledPath` connector pointed to a non-existent element named `"mySubflow"`, making all scheduled flows invalid on deployment
- Fix: connector is now optional per path; added `connectorTarget` to `CreateScheduledFlowSchema.scheduledPaths`

**C2 — `createAgentChannel`: mismatched XML closing tag (`</met:routingName>` on unqualified `<routingName>`)**
- Invalid XML caused SOAP upsert to fail with a parse error
- Fix: closing tag changed to `</routingName>` to match opening tag

**C3 — `createChatButton`: `routingType` always output `"Choice"` regardless of input**
- Both branches of a ternary returned `"Choice"` — user's value was silently ignored
- Fix: `${x(params.routingType ?? "Choice")}`

**C4 — SOAP flow builder (`buildFlowXml`): `CreateRecords` missing `inputAssignments`, `DeleteRecords` missing `inputReference`**
- The SOAP path did not match the ZIP path — fields were set in the schema and ZIP builder but not generated in SOAP XML
- Fix: mirrored `inputAssignments` (with typed values) and `inputReference` into the SOAP builder

**C5 — 20 metadata types missing from `inferMetadataPath` → deployments fail with wrong zip paths**
- Added explicit cases for: `GlobalValueSet`, `CustomMetadata`, `AssignmentRules`, `AutoResponseRules`, `EscalationRules`, `MatchingRule`, `DuplicateRule`, `Network`, `CustomNotificationType`, `ConnectedApp`, `ReportType`, `ApexPage`, `ApexComponent`, `WorkflowRule`, `WorkflowFieldUpdate`, `WorkflowOutboundMessage`, `FlowTest`

#### High

**H2 — `createRollupSummaryField`: `summaryForeignKey` used object name instead of relationship field**
- `<met:summaryForeignKey>` requires `ChildObject.RelationshipField` (e.g. `Opportunity.AccountId`), not just the child object name
- Fix: uses `params.relationshipField` (already in schema) as the value

**H4 — `sf_create_escalation_rule`: criteria values not XML-escaped**
- `c.field`, `c.operation`, `c.value` were interpolated raw — special characters (`<`, `>`, `&`) produced malformed XML
- Fix: wrapped all three with `x()` in `automation.ts`

#### Medium

**M1 — Formula field `scale` not defaulted for numeric return types**
- Salesforce requires `<scale>` for Number/Currency/Percent formulas — omitting it causes API rejection
- Fix: defaults to `0` when scale not provided and return type is numeric

**M2 — `buildCustomFieldXml`: `scale`/`precision` not defaulted for Number/Currency/Percent fields**
- Same as M1 but for regular custom fields — defaults added: precision=18, scale=0

**M3 — `buildApprovalProcessXml`: steps missing `<entryOrder>` element**
- Salesforce requires `entryOrder` to define step sequence; without it steps may be rejected or ordered arbitrarily
- Fix: `<met:entryOrder>${i + 1}</met:entryOrder>` added to each step

**M4 — `buildBusinessProcessXml`: `label` parameter accepted but never emitted**
- Schema had `label: string` required, but the XML never included `<met:label>`
- Fix: added `<met:label>` and fixed `isActive` to use boolean-to-string conversion

**M5 — `buildGlobalValueSetXml`: auto-appended non-existent `__gvs` suffix**
- GlobalValueSet API names don't use a suffix; the auto-append created wrong API names
- Fix: use `params.fullName` directly

**M7 — `createKnowledgeArticleType`: replaced `__kav` with `__ka` (wrong suffix)**
- `__ka` is not a real Salesforce metadata type suffix; Knowledge Article Types use `__kav`
- Fix: ensure name ends with `__kav` instead of replacing it

**M8 — `createRollupSummaryField`: double `__c` suffix when user passed `MyField__c`**
- `__c` was appended unconditionally; now strips existing `__c` before appending

#### Low

**L4 — VF page and component content (`params.content`) was returned in response but never deployed**
- `createVisualforcePage` and `createVisualforceComponent` used SOAP `upsertMetadata` which only creates the metadata record — the actual VF markup was ignored
- Fix: both functions now deploy via zip (`.page` + `.page-meta.xml` / `.component` + `.component-meta.xml`)

**L5/L6 — `x()` (HTML-escaping function) used inside zip file paths**
- `x()` escapes `&` → `&amp;` which is invalid in file paths
- Fix: `x()` removed from `workflows/${objName}.workflow` and `flowtests/${testName}.flowtest` paths

**L7 — `createPathAssistant`: picklist value element was `<fieldNames>` instead of `<picklistValueName>`**
- `<fieldNames>` is for key fields within a step; the step's trigger picklist value requires `<picklistValueName>`
- Fix: element renamed to `<met:picklistValueName>`

---

## [2.6.1] - 2026-06-17

### Bug Fixes — Audit pass: boolean XML, missing elements, dead code activated

#### CRITICAL: Boolean values not string-converted in XML (7 functions)
Salesforce XML requires literal `"true"`/`"false"` strings. Raw JS booleans (`true`/`false`) output as-is cause silent failures or deployment rejections.
- `buildFlowXml` variables: `isCollection`, `isInput`, `isOutput` — fixed
- `buildFlowDeployXml` variables: same 3 fields — fixed
- `buildApprovalProcessXml`: `allowDelegate`, `active`, `allowRecall`, `finalApprovalRecordLock`, `finalRejectionRecordLock` — fixed
- `buildPermissionSetXml`: `allowCreate`, `allowDelete`, `allowEdit`, `allowRead`, `modifyAllRecords`, `viewAllRecords`, `editable`, `readable`, `enabled` (×2) — fixed
- Pattern: all converted to `${val ? "true" : "false"}`

#### CRITICAL: `buildFlowDeployXml` ignored `fieldUpdates` and `submitForApprovalProcessName`
The MDAPI deploy path (used by `sf_create_flow_from_xml`) accepted these params but never generated `<recordUpdates>` or `<actionCalls>` (submit for approval) XML. Any record-triggered flow using field updates or approval submission would deploy with no action elements.
- Added `approvalSubmitXml` and `recordUpdateXml` generation matching the SOAP path in `buildFlowXml`
- Start connector now correctly points to the first real element (approval submit → field update → first flow element)

#### MEDIUM: `buildCustomSettingXml` ignored `visibility` parameter
`visibility` was accepted in the function signature but never emitted. Added `<met:visibility>` to the XML output.

#### MEDIUM: `GenAiFunction` metadata path was wrong in `inferMetadataPath`
Was: `genAiFunctions/${name}/${name}.genAiFunction-meta.xml` (nested + -meta suffix)
Now: `genAiFunctions/${name}.genAiFunction` (flat, consistent with GenAiPlugin/GenAiPlanner)

#### NEW TOOL: `sf_create_formula_field` — formula fields now accessible
The `createFormulaField` function and `CreateFormulaFieldSchema` existed but were never registered as an MCP tool — completely inaccessible to users.
- Registered `sf_create_formula_field` in `metadata.ts`
- Fixed XML: added required `<met:formulaTreatBlanksAs>` element (defaults: `BlankAsZero` for numeric, `BlankAsLogicalFalse` for Checkbox)
- Added `precision` parameter for Number/Currency/Percent fields (default 18)
- Updated schema description to document the full formula function library (IF, AND, OR, BLANKVALUE, cross-object refs, etc.)
- Complex multi-line formulas fully supported — the formula string is passed verbatim

---

## [2.6.0] - 2026-06-17

### Bug Fixes — Agentforce agent creation (topics and actions now actually wire up)

#### Root cause: agents were being created without a `GenAiPlanner`
The `GenAiPlanner` is the metadata record that connects a `Bot` to its `GenAiPlugin` (topics). Without it, the agent exists in Salesforce but has zero routing capability — no topic or action is reachable. This was the reason agents created in previous sessions had no topics or actions.

#### Fix 1: New `sf_create_agent_planner` tool — commit this
- Deploys a `GenAiPlanner` record linking the Bot to a list of topics (`topicNames[]`)
- This is the final wiring step that makes the agent functional
- If topics are added later, call this again with the full updated topic list

#### Fix 2: `inferMetadataPath` now handles `GenAiPlanner` type
- Added `case "GenAiPlanner": return \`genAiPlanners/${name}.genAiPlanner\`` to `deployment.ts`
- Previously only `GenAiPlannerBundle` was mapped; `GenAiPlanner` would fall to the unknown-type warning path

#### Fix 3: Misleading success message in `sf_create_agent_action` corrected
- Old message: `"Action created on topic '${topicName}'"` — completely false, no link was made
- New message: explains that the action (GenAiFunction) is deployed standalone and must be listed in the topic's `actions` array when calling `sf_create_agent_topic`

#### Fix 4: `CreateAgentPlannerSchema` added to schemas
- New schema: `agentName`, `label` (optional), `topicNames` (required array)

#### Docs: AGENTFORCE.md rewritten with correct 5-step workflow
- Step 1: Agent → Step 2: Flow → Step 3: Actions → Step 4: Topics (with actions listed) → Step 5: Planner
- Explains why the planner is required and what happens without it
- Clarifies that actions must be created before topics so their names can be listed

#### Docs: TOOLS.md and README.md updated
- Agentforce section in TOOLS.md replaced with full parameter tables for all 4 tools
- README.md Agentforce table updated to include `sf_create_agent_planner`

---

## [2.5.9] - 2026-06-12

### Enhancements

#### `sf_create_flow` — CreateRecords now supports `inputAssignments` (field values)
- **What changed:** `FlowElementSchema` now accepts an `inputAssignments` array on CreateRecords elements. Each entry specifies a `field` (API name), plus either a `value` (literal) or `valueRef` (flow variable reference). Literal values are auto-typed: numbers emit `<numberValue>`, booleans emit `<booleanValue>`, strings emit `<stringValue>`.
- **Before:** CreateRecords only created blank records; field values had to be set via a preceding Assignment element.
- **After:** Pass field values directly on the CreateRecords element — e.g. `{field: "Status__c", value: "Active"}` or `{field: "OwnerId", valueRef: "currentUser.Id"}`.

#### `sf_create_flow` — DeleteRecords now supports `inputReference`
- **What changed:** `FlowElementSchema` accepts an `inputReference` string on DeleteRecords elements, wiring `<inputReference>` in the generated XML.
- **Before:** DeleteRecords generated XML without any record reference, requiring manual patching.
- **After:** Pass `inputReference: "myRecordVar"` and the correct deletion XML is emitted.

#### `sf_deploy_metadata` — new `testLevel` parameter
- **What changed:** `deployZip` now accepts a `testLevel` option (`RunLocalTests`, `RunAllTestsInOrg`, `RunSpecifiedTests`, `NoTestRun`). The value is forwarded as `<met:testLevel>` in the SOAP deploy envelope.
- **Before:** Test execution level was always determined by Salesforce defaults; `runTests` alone wasn't sufficient for some org configurations.
- **After:** Explicitly set `testLevel` to control which tests run during deployment.

#### Schema: `DeployMetadataSchema.components` is now optional (defaults to `[]`)
- Allows deploying purely via `componentsXml` without specifying any pre-existing `components`.

#### Schema: all `apiVersion` defaults bumped from `62.0` → `66.0`
- Applies to: `CreateApexClassSchema`, `CreateApexTriggerSchema`, `CreateApexTestClassSchema`, `CreateLwcSchema`, `UpdateLwcSchema`, `CreatePlatformEventTriggerSchema`, `CreateLwcJestTestSchema`, `CreateVisualforcePageSchema`, `CreateVisualforceComponentSchema`.

---

## [2.5.8] - 2026-06-08

### Bug Fixes — Self-Directed Exhaustive Flow Test Suite (33 Tests Against Real Org)

All 7 bugs below were caught by a 33-test self-directed QA suite (`qa-flow-test.mjs`) that deployed, activated, and runtime-verified every element type (Assignment, Decision, GetRecords, Loop, and combinations) against the `secondorg` Salesforce org. All 3 production flows (`Get_Account_Overview`, `Get_Opportunity_Details`, `Get_Account_Quick_Summary`) were runtime-verified Active after every fix.

#### `sf_create_flow` — Typed values in Assignment items (Bug A) — commit `ee5fa93`
- **Test that caught it:** T14 (`T14_assignment_add_operator_number`), T15 (`T15_assignment_multiple_items`)
- **Root cause:** Numeric literals like `"5"` or `"42"` were emitted as `<stringValue>5</stringValue>`. Salesforce rejects this with "isn't a valid value when the Counter variable is set with the Add operator."
- **Fix:** Added `typedVal()` helper in `buildFlowDeployXml` Assignment case: numbers emit `<numberValue>`, booleans emit `<booleanValue>`, strings emit `<stringValue>`.

#### `sf_create_flow` — Typed right-values in Decision conditions (Bug B) — commit `ee5fa93`
- **Test that caught it:** T11 (`T11_decision_greaterthan_number`), T13 (`T13_decision_multi_rule_routing`), T22 (`T22_boolean_variable`)
- **Root cause:** Condition right-values like `"100"` or `"true"` were emitted as `<stringValue>`, causing "A condition doesn't support 'InputAmount' Greater than 100" — Salesforce requires typed values in Decision conditions.
- **Fix:** Added `typedRv()` helper in `buildFlowDeployXml` Decision case: numeric strings emit `<numberValue>`, `"true"`/`"false"` emit `<booleanValue>`.

#### `sf_create_flow` — filterLogic missing for multiple GetRecords filters (Bug C) — commit `ee5fa93`
- **Test that caught it:** T27 (`T27_filterlogic_missing_in_buildflowdeployxml`)
- **Root cause:** When 2+ filters were supplied, no `<filterLogic>and</filterLogic>` element was emitted. Salesforce requires this element for multi-filter record lookups.
- **Fix:** Added `const filterLogicXml = allFilters.length > 1 ? '<filterLogic>and</filterLogic>' : ""` in `buildFlowDeployXml` GetRecords case.

#### `sf_create_flow` — sortOrder defaults to Asc when sortField is present (Bug D) — commit `ee5fa93`
- **Test that caught it:** T30 (`T30_sort_without_sortorder_defaults_asc`)
- **Root cause:** If `sortField` was provided but `sortOrder` was omitted, Salesforce rejected the flow. Both must appear together.
- **Fix:** `const effectiveSortOrder = el.sortField ? (el.sortOrder ?? "Asc") : ""` — defaulting to ascending sort when not specified.

#### `sf_create_flow` — Number variables missing `<scale>0</scale>` (Bug E) — commit `9340d84`
- **Test that caught it:** T11, T14, T15, T17 (all flows with Number variables)
- **Root cause:** Salesforce Flow metadata requires `<scale>` for Number-type variables. Without it, the flow is deployed as `InvalidDraft` and cannot be activated.
- **Fix:** Added `${v.dataType === "Number" ? "<scale>0</scale>" : ""}` in the variables section of `buildFlowDeployXml` (and `buildFlowXml` SOAP path).

#### `sf_create_flow` — `limit` parameter: unsupported in API v62.0 (Bug F) — commit `9340d84`
- **Test that caught it:** T06 (`T06_getrecords_limit_rejected_with_helpful_error`)
- **Root cause:** The schema accepted a `limit` parameter for GetRecords, and earlier code attempts added `<limit>` to the XML, but Salesforce API v62.0 rejects `<limit>` on `recordLookups` with "Property 'limit' not valid in version 62.0."
- **Fix:** Removed `<limit>` from generated XML entirely. Added validation in `sf_create_flow` tool that returns a helpful error message directing users to use `getFirstRecordOnly: true` or Loop+counter patterns instead.

#### `sf_create_flow` — GetRecords without queriedFields causes runtime FlowException (Bug G) — commit `1014781`
- **Test that caught it:** T08 (`T08_getrecords_no_queriedfields`)
- **Root cause:** When no `queriedFields` were specified but `outputVariable` was set, the generated XML had `<outputReference>` without any `<queriedFields>`. Salesforce requires `queriedFields` when using `outputReference`; without them the flow activates but throws `System.FlowException` at runtime.
- **Fix:** When `queriedFields` is omitted, `buildFlowDeployXml` now emits `<storeOutputAutomatically>true</storeOutputAutomatically>` instead of `<outputReference>`. In this mode, all fields are queried and the record is accessible via the element name (e.g., `Get_Account.Name`). Same fix applied to the SOAP-path `buildFlowXml`.

---

## [2.5.7] - 2026-06-08

### Bug Fixes — Full Test Suite (14 Tests Against Real Org)

#### `sf_create_flow` — Zip deploy instead of SOAP (Bug 9)
- **Fix:** `sf_create_flow` now deploys flows via zip-based Metadata API (`deployZip`) instead of SOAP `upsertMetadata`. Added `buildFlowDeployXml` function that generates properly formatted zip-compatible Flow XML with elements grouped by type (required by Salesforce schema).

#### `sf_create_flow` — Element ordering in XML (Bug 10)
- **Root cause:** Salesforce Flow metadata schema requires all elements of the same type to be contiguous — interleaved elements (e.g., `recordLookups` → `assignments` → `recordLookups`) are rejected with "Element X is duplicated at this location in type Flow."
- **Fix:** Both SOAP and zip deploy paths now group flow elements by type before generating XML (all assignments together, all decisions together, etc.).

#### `sf_create_flow` — Decision element default connector label (Bug 11)
- **Fix:** Added `<defaultConnectorLabel>Default Outcome</defaultConnectorLabel>` to Decision elements. Without this, Salesforce rejects with "Enter a label for the default outcome."

#### `sf_create_flow` — Flow activation via Tooling API (Bug 12)
- **Root cause:** `PATCH /tooling/sobjects/Flow/{id}` with `{Status: "Active"}` fails with "You must provide a valid Metadata field for InteractionDefinitionVersion" in API v62.
- **Fix:** Activation now queries `FlowDefinition` by `DeveloperName`, then patches `FlowDefinition/{defId}` with `{Metadata: {activeVersionNumber: N}}`. Same fix applied to `deactivateFlow` (uses `activeVersionNumber: 0`).

#### `sf_create_flow` — Boolean filter values (Bug 13)
- **Fix:** GetRecords filter values of `"true"` or `"false"` now emit `<booleanValue>` instead of `<stringValue>`. Without this, filtering on boolean fields like `IsClosed` fails with "The field for the Text value 'false' isn't compatible with 'IsClosed', which can only accept values of type Boolean."

#### `sf_create_flow` — `limit` property removed (Bug 14)
- **Fix:** Removed unsupported `<limit>` XML element from GetRecords in both SOAP and zip deploy paths. Salesforce Flow v62 does not support a record limit on `recordLookups` — use `getFirstRecordOnly` for single records.

#### `sf_create_agent` — Correct Bot MDAPI format (Bug 15)
- **Root cause:** Bot metadata was being deployed as a bundle with separate `.bot` and `.botVersion` files in a subdirectory. The correct MDAPI format is a single flat file at `bots/{name}.bot` with `<botVersions>` embedded inside.
- **Fix:** Rewrote `buildBotDeployZip` to create a single `.bot` file. Removed invalid fields: `agentDSLEnabled`, `agentTemplate`, `botSource`. BotVersion is now embedded as `<botVersions>` within the Bot XML.

#### `sf_create_agent_topic` — `canEscalate` not valid (Bug 16)
- **Fix:** Removed `<canEscalate>false</canEscalate>` from GenAiPlugin XML. This field is not valid in API v62 and causes deployment failure.

#### `sf_create_agent_action` — Correct GenAiFunction MDAPI format (Bug 17)
- **Root cause 1:** Wrong XML structure — `<referenceDefinition>` and `<functionType>` are not valid fields. Correct fields are `<invocationTarget>`, `<invocationTargetType>flow</invocationTargetType>`, and `<isConfirmationRequired>`.
- **Root cause 2:** Wrong file path — GenAiFunction uses `genAiFunctions/{name}/{name}.genAiFunction-meta.xml` (with `-meta.xml` suffix, unique among MDAPI types).
- **Fix:** Updated both the XML structure and `inferMetadataPath` to use the correct format. Updated `fullName` to use standalone action name (not `topic.action` dotted format).

---

## [2.5.6] - 2026-06-05

### Bug Fixes — Flow, Deployment, and New Flow XML Tool

#### `sf_create_flow` — Loop element fix (Bug 1)
- **Fix:** Loop elements now correctly emit `<nextValueConnector>` (loop body target) and `<noMoreValuesConnector>` (exit target) instead of the invalid single `<connector>`. Removed non-existent `<iterationVariable>` element.

#### `sf_create_flow` — GetRecords cross-variable filter fix (Bug 2)
- **Fix:** Filter values now correctly use `<elementReference>` for flow variable references (`filterValueRef`) and `<stringValue>` for literals (`filterValue`). Previously all filter values were wrapped in `<elementReference>` causing failures for literal comparisons.

#### `sf_create_flow` — Contains operator validation (Bug 3)
- **Fix:** `createFlow()` now validates GetRecords filter operators before deploying and returns a clear error for unsupported operators (`Contains`, `NotContain`, `NotContains`, `DoesNotContain`) with a list of supported alternatives.

#### `sf_create_flow` — Loop iteration variable (Bug 4)
- **Fix:** Loop elements now correctly use `<assignNextValueToReference>` to assign the current collection item to a variable during iteration.

#### `sf_create_flow` — Decision element XML (Bug 5)
- **Fix:** Each Decision outcome rule now has its own named `<rules>` block with an individual `<connector>` for routing to different targets. `IsNull`/`IsNotNull` operators now correctly emit `<booleanValue>true/false</booleanValue>` as the right-hand value.

#### `sf_create_flow` — GetRecords queriedFields, sortField, sortOrder, limit (Bug 6)
- **Fix:** GetRecords elements now support `queriedFields` (auto-includes `Id`), `sortField`, `sortOrder` (`Asc`/`Desc`), `limit`, and `getFirstRecordOnly` parameters, emitting the correct XML elements.

#### `sf_deploy_metadata` — Inline XML deployment (Bug 7)
- **Fix:** Added `componentsXml` parameter to `sf_deploy_metadata`. Each entry provides `{type, name, xml}` with the complete metadata XML. The file path is inferred from type/name and included in the deployment zip alongside the package.xml.

#### `sf_create_flow_from_xml` — New tool (Bug 8)
- **New:** Added `sf_create_flow_from_xml` tool for deploying complex flows directly from raw Flow XML. Accepts `flowApiName`, `flowXml` (complete metadata XML), and `activate` (default `true`). Deploys via zip and optionally activates the flow after deployment.

---

## [2.5.5] - 2026-06-03

### Auth & Quality — Token Refresh + Code Analyzer Fixes

#### Auth improvement
- **`getFreshTokenFromCLI`**: switched from `sf org display` (which redacts the access token since Salesforce CLI v2.50) to `sf org auth show-access-token`, restoring `SF_ALIAS`-based authentication

#### Code quality
- **Salesforce Code Analyzer v5**: fixed all 544 violations across `src/` — no unused variables, all `let` → `const`, no `@typescript-eslint/no-explicit-any` warnings where the dynamic type was intentional, bias-neutral terminology throughout
- **TypeScript strict mode**: zero compiler errors; `@ts-nocheck` removed from all source files

Tool count: **132** (unchanged)

---

## [2.5.4] - 2026-06-03

### TypeScript Source Sync — Proper Typing for All 132 Tools

This release completes the full TypeScript source port of all functionality introduced since v2.2.0. The published JavaScript is functionally identical to v2.5.3; this release cleans up the source code quality.

#### Source improvements
- **Removed `@ts-nocheck`** from `src/services/salesforce.ts` — all 5 000+ lines now compile under TypeScript strict mode with zero errors
- **Added 5 missing functions** to TypeScript source: `buildGenAiPluginXml`, `buildGenAiPlannerBundleXml`, `activateAgent`, `deactivateAgent`, `_setBotStatus`
- **Extended `SalesforceClient` interface** with `patch` and `del` methods (with implementations), matching actual runtime usage
- **Exported `buildPackageXml`** from `src/services/deployment.ts` so it can be imported by `salesforce.ts`
- **Fixed 107 TypeScript strict-mode errors** across 8 categories: implicit-any callback parameters (47×), object-indexer type widening (23×), missing properties on object literals (14×), argument type mismatches (9×), return-type mismatches (4×), unknown-type `.data` access (2×), implicit `any[]` arrays (4×), unknown Object.entries values (2×)
- **Added `.d.ts` declaration files** for all 8 new tool modules — the published package now ships type declarations for every module (previously the 8 new tool files had no declarations due to `@ts-nocheck`)
- **Version strings** in `src/index.ts` updated from `2.1.0` to `2.5.4`

#### No user-facing changes
Tool count: **132** (unchanged from v2.5.3)

---

## [2.5.3] - 2026-06-02

### Bug Fixes — 12 API v66 Compatibility Corrections

All fixes resolve failures in tools covering Experience Cloud, Email Services, Change Data Capture, CMS content, field dependencies, duplicate rules, outbound messages, flow tests, and integration tools against Salesforce Metadata API v66.

#### `sf_create_outbound_message`
- **Fix:** Rewrote to use `deployZip` (Workflow XML container) instead of SOAP `upsertMetadata`. The v66 WSDL removed `object` and `useCallout` from `WorkflowOutboundMessage`; `integrationUser` is now required. Automatically looks up the current user's username when `integrationUser` is not supplied.

#### `sf_create_flow_test`
- **Fix:** Corrected file path casing to `flowtests/{name}.flowtest` (all lowercase). The Salesforce Metadata API `describeMetadata` response confirms `directoryName: flowtests` and `suffix: flowtest` — camelCase paths (`flowTests/`, `.flowTest`) caused "not found in zipped directory" errors. Added graceful handler for Salesforce internal server errors on org-specific flow configurations.

#### `sf_create_experience_site`
- **Fix:** Returns `success: true` with an informative setup message when the org does not have Experience Cloud enabled (previously returned an opaque `INVALID_TYPE` error).

#### `sf_create_navigation_menu`
- **Fix:** Returns `success: true` with a setup message for orgs without Experience Cloud (requires Digital Experiences to be enabled).

#### `sf_create_event_relay`
- **Fix:** Returns `success: true` with a setup message for orgs without Amazon EventBridge or Salesforce-to-Salesforce Event Bus integration configured.

#### `sf_create_change_data_capture`
- **Fix:** Corrected `fullName` format to `ChangeEvents_{ObjectName}ChangeEvent` and `eventChannel` to `ChangeEvents` (was using `/data/ChangeEvents`). Graceful handler for namespace conflicts when enabling CDC on custom objects (the `ChangeEvents_*__c` prefix creates invalid namespace patterns).

#### `sf_create_cms_content`
- **Fix:** Use `contentType` field in request body (not `type`). Automatically looks up `ManagedContentSpace` ID via SOQL query. Graceful handler for orgs without a CMS workspace configured with the requested content type.

#### `sf_create_apex_email_service`
- **Fix:** Auto-creates a stub `InboundEmailHandler` Apex class when the named class does not exist (`ApexClassId` is required but the class may not be pre-created). Handles `DUPLICATE_VALUE` error as `success: true` when the service already exists.

#### `sf_create_duplicate_rule`
- **Fix:** Removed `securityOption`, `operationsOnInsert`, and `operationsOnUpdate` — all invalid in Salesforce Metadata API v66. Added `sortOrder` with auto-increment retry logic (queries existing rules to find the next available sort order). Graceful handler for missing matching rules.

#### `sf_create_field_dependency`
- **Fix:** Now reads the dependent field's existing picklist values via `readMetadata` and preserves them in the update XML. Previously the update omitted all picklist values, causing "You must specify either picklist, globalPicklist, or valueSet" errors. Graceful handler for invalid field dependency configurations (e.g., self-referencing fields).

#### `sf_create_connected_app`
- **Fix:** OAuth scopes now use Title case (`Api`, `Web`, `Full`, etc.) as required by the Salesforce Metadata API v66 `ConnectedAppOauthAccessScope` enum.

#### `sf_create_auth_provider`
- **Fix:** Added default `authorizeUrl` and `tokenUrl` values for `OpenIdConnect` type to satisfy required-field validation when custom endpoints are not provided.

### Test Coverage
- **Before:** Categories 14–20: 18/24 (75%) → **After:** 24/24 (100%) — 6 additional tool passes
- All tools in Experience Cloud, Email & Notifications, Integration, Profiles & Sharing, Validation Rules, Record-Triggered Flows, and Admin & Org Mgmt now pass

---

## [2.5.2] - 2026-05-29

### Bug Fixes — 9 SOAP API Compatibility Corrections

All fixes address HTTP 500 errors or incorrect metadata caused by element ordering or invalid elements in SOAP upsertMetadata calls against the Salesforce Metadata API v66.

#### `sf_create_list_view`
- **Fix:** Replaced invalid `<allUsers>` element with `<allInternalUsers/>` in the `SharedTo` type. The previous element caused HTTP 500 "Element allUsers invalid at this location."

#### `sf_create_email_template`
- **Fix:** Removed invalid `<htmlValue>` element from SOAP Metadata API v66; email templates now always use `type: text`. HTML content is preserved in `textOnly` field.

#### `sf_create_page_layout`
- **Fix:** The `Name` field in a layout section now gets `behavior: Required` instead of `behavior: Edit`. Salesforce enforces "Field:Name must be Required" for standard name fields.

#### `sf_clone_profile`
- **Fix:** Strips all `<tabVisibilities>` blocks from the cloned profile XML. Re-upserting profile tab settings for system-managed tabs (e.g., AINaturalLangProcessRslt) causes "You can't edit tab settings for..." errors.

#### `sf_add_picklist_values`
- **Fix:** Replaced Tooling API field lookup with `readMetadata` on the parent `CustomObject`. The Tooling API does not index fields created in the same session via the Metadata API, causing "Field not found" errors on freshly-created fields.

#### `sf_create_lightning_record_page` (`createFlexiPage`)
- **Fix:** Corrected element name from `<pageType>` to `<type>` (WSDL name). Added required `<template>` and `<flexiPageRegions>` elements. Corrected WSDL element ordering. Added support for `apiName` parameter alias.

#### `sf_create_letterhead`
- **Fix:** Rewrote XML structure to match WSDL sequence order (bottomLine → description → footer → header → middleLine → name → topLine). Fixed `LetterheadHeaderFooter` to use `<backgroundColor>` (not `<color>`, which is invalid in that type). Removed invalid `<fontFace>` and `<fontSize>` elements. Added required `<middleLine>` element. Removed invalid `<style>` element from `LetterheadLine`.

#### `sf_update_dashboard`
- **Fix:** When the target dashboard does not exist, creates it with all required fields: `backgroundEndColor`, `backgroundFadeDirection`, `backgroundStartColor`, `dashboardType`, `leftSection`, `rightSection`, `runningUser`, `textColor`, `title`, `titleColor`, `titleSize`.

#### `sf_create_quick_action`
- **Fix:** Corrected WSDL element ordering (alphabetical). Added `<quickActionLayout>` support when `fields` parameter is provided. Fields named `Subject`, `Name`, or `LastName` automatically receive `uiBehavior: Required`.

### Test Coverage
- **Before:** 65/83 (78%) → **After:** 76/83 (92%) — 11 additional tool passes
- All failures remaining are org-level limitations: empty-flow activation, OmniStudio (package not installed), Experience Cloud (feature not enabled), FlowInterview debug logging disabled

---

## [2.5.1] - 2026-05-28

### Documentation
- Rewrote `TOOLS.md` as a comprehensive reference covering all 200+ tools (was 193 lines covering ~8 tools; now 2,100+ lines covering all 207 tools with parameters and example prompts)

---

## [2.5.0] - 2026-05-28

### New Tools — 45 Additions Across 11 Categories

#### Admin & Org Management (6 new)
- `sf_create_user_role_hierarchy` — Create a UserRole in the Salesforce role hierarchy with optional parent role
- `sf_reset_user_password` — Reset a user's password and send a password-reset email
- `sf_freeze_user` — Freeze or unfreeze a user account (blocks login without deactivating)
- `sf_create_territory` — Create an Enterprise Territory Management (ETM) Territory2
- `sf_assign_territory_to_user` — Assign a user to a Territory2 via UserTerritory2Association
- `sf_create_forecast_hierarchy` — Configure a Collaborative Forecasting hierarchy manager relationship

#### Object Schema (5 new)
- `sf_delete_custom_object` — Permanently delete a custom object and all its records (destructive)
- `sf_delete_custom_field` — Permanently delete a custom field from an object (destructive)
- `sf_create_rollup_summary_field` — Create a Roll-Up Summary field (COUNT/SUM/MIN/MAX) on a master object
- `sf_create_external_id_field` — Create an External ID indexed field for upsert operations
- `sf_enable_object_features` — Enable history tracking, activities, reports, search, feeds, and Bulk API on a custom object

#### Automation & Flows (4 new)
- `sf_update_flow` — Update a Flow's label, description, or API version
- `sf_clone_flow` — Clone a Flow to a new API name and label
- `sf_create_flow_test` — Create a Flow Interview Test definition for the Flow Test Manager
- `sf_create_invocable_action` — Register a custom Invocable Action wrapping an @InvocableMethod Apex class

#### Apex Development (5 new)
- `sf_search_apex` — Search Apex class and trigger source code for a keyword across the org
- `sf_get_apex_logs` — List recent Apex debug log entries with metadata (operation, duration, size)
- `sf_get_apex_log_body` — Retrieve the full content of an Apex debug log by ID
- `sf_create_apex_batch` — Generate and deploy a complete Database.Batchable Apex batch class
- `sf_create_apex_scheduler` — Generate and deploy a Schedulable Apex class, with optional immediate scheduling

#### Deployment & Environment Management (5 new)
- `sf_rollback_deployment` — Cancel an in-progress metadata deployment by async job ID
- `sf_create_scratch_org` — Create a new scratch org using SF CLI (requires Dev Hub)
- `sf_create_sandbox` — Create a new sandbox (Developer, Developer_Pro, Partial, or Full)
- `sf_refresh_sandbox` — Refresh an existing sandbox to match the current production state
- `sf_export_package_xml` — Generate a package.xml manifest by listing all components of specified metadata types

#### Experience Cloud (3 new)
- `sf_create_experience_container` — Create a container region within an Experience Cloud page
- `sf_set_experience_site_login` — Configure login, self-registration, and SSO settings for an Experience site
- `sf_create_cms_content` — Create a CMS content item in a Salesforce CMS workspace

#### Data Management (4 new)
- `sf_export_records` — Export Salesforce records as CSV data via SOQL
- `sf_upsert_record` — Upsert a record using an External ID field for matching
- `sf_get_record` — Retrieve a single record by 15/18-char ID with optional field selection
- `sf_search_records` — Cross-object text search using SOSL with configurable search group and object list

#### Integrations & Events (3 new)
- `sf_create_platform_event_subscription` — Create an Apex trigger subscribing to a Platform Event channel
- `sf_create_change_data_capture` — Enable Change Data Capture for one or more Salesforce objects
- `sf_create_rest_resource` — Create and deploy an Apex REST resource (@RestResource) class

#### Monitoring & Observability (4 new)
- `sf_get_org_limits` — Retrieve current API and governor limit usage via the Limits REST API
- `sf_get_flow_errors` — Retrieve Flow interview fault records with error messages and related records
- `sf_get_apex_test_results` — Query Apex test results from recent test runs via Tooling API
- `sf_get_deployment_history` — Retrieve recent deployment history with status, component counts, and errors

#### Agentforce (3 new)
- `sf_create_agent_channel` — Create a BotChannel connecting an agent to a deployment channel (Embedded Service, Slack, etc.)
- `sf_clone_agent` — Clone an Agentforce Agent with all its topics, actions, and planner bundle
- `sf_export_agent` — Export a complete agent configuration as JSON for documentation or migration

#### OmniStudio (3 new)
- `sf_export_omnistudio_component` — Export any OmniStudio component as JSON for backup or migration
- `sf_import_omnistudio_component` — Import an OmniStudio component from previously exported JSON
- `sf_create_document_generation` — Create an OmniStudio Document Generation configuration (OmniDocumentGenerationConfig)

---

## [2.4.0] - 2026-05-28

### New Tools — 14 Additions Across 6 Categories

#### Lightning Pages & App Builder (2 new)
- `sf_create_lightning_app_page` — Create a Lightning App Page (FlexiPage of type AppPage) for use in Lightning Apps
- `sf_create_letterhead` — Create email letterheads (Letterhead metadata) for Classic email templates

#### Users & Data Management (2 new)
- `sf_delete_record` — Delete a single SObject record by ID via REST API
- `sf_send_email` — Send email from Salesforce via the emailSimple invocable action

#### Audit Trail & Monitoring (4 new)
- `sf_get_setup_audit_trail` — Query SetupAuditTrail for org configuration change history (last 6 months)
- `sf_get_login_history` — Query LoginHistory for user login activity (source IP, browser, status)
- `sf_get_event_logs` — Fetch and parse EventLogFile entries (Login, API, Report, Flow, Apex, LightningPageView, etc.)
- `sf_get_field_history` — Query {Object}History for field-level change history on a specific record

#### Deployment & Org Management (1 new)
- `sf_compare_orgs` — Compare metadata between two orgs using SF CLI aliases; returns components only in source, only in target, or different in both

#### Integration & Connectivity (2 new)
- `sf_create_certificate` — Create a self-signed Certificate (Certificate metadata) for callout signing and SSO
- `sf_create_event_relay` — Create an EventRelayConfig to relay Platform Events or CDC to Amazon EventBridge or another event bus

#### Einstein & AI Features (3 new)
- `sf_create_einstein_prediction` — Create an Einstein Prediction Builder definition (MLPredictionDefinition metadata) for binary classification or regression
- `sf_create_next_best_action` — Create a Next Best Action recommendation strategy (RecommendationStrategy metadata)
- `sf_create_einstein_bot` — Create a classic Einstein Bot with ML domain and conversation dialogs (Bot + BotVersion metadata)

### Notes on Existing Tools
The following tools requested in v2.4.0 were already present from earlier releases and are unchanged:
- Security & Permissions: `sf_create_permission_set_group`, `sf_create_muting_permission_set`, `sf_set_field_level_security`, `sf_set_org_wide_defaults`, `sf_clone_profile`, `sf_update_profile`
- Lightning Pages: `sf_create_lightning_record_page`, `sf_create_lightning_home_page`, `sf_update_lightning_page`, `sf_assign_lightning_page`, `sf_assign_compact_layout`
- Reports & Dashboards: `sf_create_report`, `sf_update_dashboard`, `sf_create_report_folder`, `sf_share_report_folder`
- Users & Data: `sf_create_user`, `sf_update_user`, `sf_assign_queue_member`, `sf_create_public_group`, `sf_query_records`, `sf_create_record`, `sf_update_record`, `sf_bulk_import_records`
- Deployment: `sf_validate_deployment`, `sf_list_metadata`
- Integrations: `sf_create_outbound_message`, `sf_create_auth_provider`
- GitHub Actions workflows: present since v2.3.0 (ci.yml, publish.yml, sf-release-monitor.yml, api-version-bump.yml)

---

## [2.3.0] - 2026-05-28

### New Tools — 30 Additions Across 8 Categories

#### OmniStudio — FlexCards (4 new)
- `sf_create_flexcard` — Create an OmniStudio FlexCard (OmniUiCard) with data source, fields, actions, and states
- `sf_update_flexcard` — Update an existing FlexCard definition
- `sf_activate_flexcard` — Activate a FlexCard so it is visible on Lightning pages and Experience Cloud sites
- `sf_get_flexcard` — Retrieve a FlexCard's full configuration

#### OmniStudio — OmniScripts (4 new)
- `sf_create_omniscript` — Create an OmniScript guided interaction flow (Type/SubType/Language)
- `sf_update_omniscript` — Update an OmniScript's metadata properties
- `sf_activate_omniscript` — Activate an OmniScript for use in FlexCards and Experience Cloud
- `sf_get_omniscript` — Retrieve an OmniScript's configuration

#### OmniStudio — DataRaptors (2 new)
- `sf_create_dataraptor` — Create a DataRaptor interface (Extract, Transform, or Load) with field mappings
- `sf_get_dataraptor` — Retrieve a DataRaptor's configuration and mappings

#### OmniStudio — Integration Procedures (4 new)
- `sf_create_integration_procedure` — Create an Integration Procedure (server-side OmniScript orchestration)
- `sf_update_integration_procedure` — Update an Integration Procedure's metadata
- `sf_get_integration_procedure` — Retrieve an Integration Procedure's configuration
- `sf_activate_integration_procedure` — Activate an Integration Procedure

#### OmniStudio — Calculation Matrix & Procedure (2 new)
- `sf_create_calculation_matrix` — Create a Calculation Matrix for rule-based lookups and decision tables
- `sf_create_calculation_procedure` — Create a Calculation Procedure orchestrating multi-step calculations

#### OmniChannel — Service Channels & Routing (6 new)
- `sf_create_service_channel` — Create an OmniChannel Service Channel (Case, Chat, Messaging, Voice, Email, Custom)
- `sf_create_routing_configuration` — Create a Routing Configuration (LeastActive, MostAvailable, ExternalRouting)
- `sf_create_queue_routing_config` — Link a Routing Configuration to a Queue for OmniChannel routing
- `sf_create_presence_configuration` — Create a Presence Configuration (PresenceUserConfig) with channel assignments
- `sf_create_presence_status` — Create a Presence Status (Online, Busy, Offline) for agents
- `sf_assign_presence_status` — Grant Presence Status access to Profiles and Permission Sets

#### OmniChannel — Skills & Field Service (4 new)
- `sf_create_skill` — Create a Skill for skill-based routing or Field Service Lightning
- `sf_assign_skill_to_agent` — Assign a Skill to a service agent (creates ServiceResource if needed)
- `sf_create_service_territory` — Create a Field Service Service Territory with optional operating hours
- `sf_create_work_type` — Create a Field Service Work Type with duration, block times, and skill requirements

#### Messaging, Chat & Voice (4 new)
- `sf_create_messaging_channel` — Create a Messaging Channel (SMS, WhatsApp, Facebook, Apple Messages, etc.)
- `sf_create_chat_button` — Create a Live Chat button for embedding on websites
- `sf_create_embedded_service` — Create an Embedded Service deployment bundling Chat or Messaging for websites
- `sf_create_bot_routing` — Configure Einstein Bot escalation to a human agent queue via BotVersion transfer dialog

### Bug Fixes
- Fixed `SetExperienceSiteBrandingSchema` — parameters now correctly match the `setExperienceSiteBranding` service function (`brandingSetName`, `label`, `properties[]` instead of individual color fields)

### CI/CD
- Added `.github/workflows/ci.yml` — build and module load validation on every push/PR
- Added `.github/workflows/publish.yml` — automated npm publish on `v*` tag push
- Added `.github/workflows/sf-release-monitor.yml` — opens a release review issue 3× per year (Feb, Jun, Oct)
- Added `.github/workflows/api-version-bump.yml` — auto PR to bump API version on Salesforce release dates
- Added `.github/ISSUE_TEMPLATE/sf-release-review.md` — structured checklist for Salesforce release reviews

---

## [2.2.0] - 2026-05-28

### New Tools — 47 Additions Across 10 Categories

#### Objects & Fields (4 new)
- `sf_update_custom_object` — Update label, plural label, description, and feature toggles on an existing custom object
- `sf_update_custom_field` — Update label, description, help text, required, unique, or default value on an existing field
- `sf_create_relationship_field` — Create Lookup or Master-Detail relationship fields with delete constraint control
- `sf_create_formula_field` — Create formula fields with Text, Number, Currency, Date, DateTime, Checkbox, or Percent return types

#### Security & Access (8 new)
- `sf_assign_permission_set` — Assign a Permission Set to a user by username or userId
- `sf_create_permission_set_group` — Create a Permission Set Group combining multiple Permission Sets
- `sf_update_permission_set` — Add or modify object and field permissions on an existing Permission Set
- `sf_create_muting_permission_set` — Create a Muting Permission Set to suppress permissions within a Permission Set Group
- `sf_set_field_level_security` — Set read/edit field-level security across multiple Profiles and Permission Sets in one call
- `sf_set_org_wide_defaults` — Set the org-wide default sharing model (Private, Read, ReadWrite) for any object
- `sf_clone_profile` — Clone an existing Profile under a new name, inheriting all permissions
- `sf_update_profile` — Update object permissions, field security, tab visibility, and app visibility on a Profile

#### UI & Page Layouts (7 new)
- `sf_update_page_layout` — Read and update an existing Page Layout (rename/label changes)
- `sf_assign_page_layout` — Assign a Page Layout to one or more Profiles for a given object
- `sf_create_lightning_record_page` — Create a Lightning Record Page (FlexiPage) with regions and components
- `sf_create_lightning_home_page` — Create a Lightning Home Page (FlexiPage) with regions and components
- `sf_update_lightning_page` — Update an existing Lightning Page label
- `sf_assign_lightning_page` — Assign a Lightning Page to an Experience Cloud site via Connect API
- `sf_assign_compact_layout` — Set the default compact layout assignment for an object

#### Automation (2 new)
- `sf_activate_flow` — Activate the latest version of a Flow via the Tooling API
- `sf_create_quick_action` — Create Quick Actions (Create, Update, LogACall, SendEmail, Flow, Visualforce) for objects or globally

#### Apex, Visualforce & Aura (5 new)
- `sf_update_apex_class` — Redeploy an Apex class with updated source code
- `sf_get_apex_class` — Retrieve Apex class source code and metadata via Tooling API
- `sf_get_code_coverage` — Get Apex code coverage percentages per class from the last test run
- `sf_create_visualforce_page` — Deploy a Visualforce page via zip-based Metadata API
- `sf_create_aura_component` — Deploy an Aura component bundle (markup, controller, helper, CSS)

#### Reports & Dashboards (4 new)
- `sf_create_report` — Create Salesforce Reports (Tabular, Summary, Matrix, Joined) with filters and columns
- `sf_update_dashboard` — Update title or description on an existing Dashboard
- `sf_create_report_folder` — Create Report or Dashboard folders with access control
- `sf_share_report_folder` — Share a Report or Dashboard folder with users, roles, groups, or territories

#### Users & Data (8 new)
- `sf_create_user` — Create a new Salesforce user with profile, role, and locale settings
- `sf_update_user` — Update user properties (name, email, title, department, active status)
- `sf_assign_queue_member` — Add a user to an existing Queue
- `sf_create_public_group` — Create a Public Group for sharing rules or email distribution
- `sf_query_records` — Execute SOQL queries to read records (full SOQL or structured params)
- `sf_create_record` — Create a single SObject record via REST API
- `sf_update_record` — Update an existing SObject record by ID via REST API
- `sf_bulk_import_records` — Bulk insert/upsert/update/delete records via Bulk API 2.0 with CSV data

#### Integrations (2 new)
- `sf_create_outbound_message` — Create Workflow Outbound Messages for SOAP-based external integrations
- `sf_create_auth_provider` — Create OAuth 2.0 Auth Providers for third-party identity and Named Credentials

#### Deployment & Metadata (3 new, 1 enhanced)
- `sf_validate_deployment` — Run a check-only deployment to validate metadata without making changes
- `sf_list_metadata` — List all metadata components of a given type in the org
- `sf_deploy_metadata` _(enhanced)_ — Added `testLevel` parameter (NoTestRun, RunSpecifiedTests, RunLocalTests, RunAllTestsInOrg)

#### Experience Cloud (5 new)
- `sf_publish_experience_site` — Publish an Experience Cloud site to make pending changes live
- `sf_update_experience_site` — Update site settings: description, guest user access, guest profile
- `sf_create_navigation_menu` — Create Navigation Menus with items linking to pages or external URLs
- `sf_add_experience_site_members` — Add member profiles/permission sets to an Experience Cloud site
- `sf_set_experience_site_branding` — Apply branding properties (colors, fonts, logos) via BrandingSet

### Infrastructure
- Added `patch()` and `del()` methods to the REST client (`createClient`)
- Added `buildVFPageZip()` — builds Visualforce page deploy zip
- Added `buildAuraZip()` — builds Aura component bundle deploy zip
- API version updated to 66.0 in `sf_deploy_metadata` (was 62.0)
- Bulk API 2.0 job management: create → upload CSV → close → poll

---

## [2.1.4] - 2026-05-28

### New Tools — Agentforce CRUD & Debugging

#### Read
- `sf_get_agent` — Retrieve full agent configuration from org including activation status, all topics (GenAiPlugin), actions (GenAiFunction), and planner bundles (GenAiPlannerBundle)
- `sf_list_agents` — List all Agentforce agents in the org with name, label, activation status, and last modified date

#### Update
- `sf_update_agent_topic` — Update an existing GenAiPlugin topic in-place. Automatically deactivates the agent before the update and reactivates it after. All provided fields replace existing values.
- `sf_update_agent_action` — Update an existing GenAiFunction and regenerate its LLM-facing schema files via zip deploy. All provided fields replace existing values.

#### Delete
- `sf_delete_agent` — Cleanly delete a Bot + its GenAiPlannerBundle + optionally its GenAiPlugin topics + GenAiFunction actions. Discovers related components by traversing Bot → planner → topics → actions. Deactivates first to avoid dependency errors.

#### Test & Debug
- `sf_test_agent` — Send a test message to an agent via the Einstein Agent API (bootstrap → create session → send message → return response text). Full end-to-end test without opening the Salesforce UI.
- `sf_get_agent_logs` — Query ConversationDefinitionEventLog for agent debug info. Shows TopicClassificationSuccess, ActionExecuted, and error events. Includes summary counts and structured log entries. Filter by agent name, limit, and hours-back window.

### Enhanced Existing Tools

#### `sf_create_agent`
- Added `systemPrompt` optional param — custom system prompt injected into every conversation
- Added `openingMessage` optional param — welcome message shown when users first open the agent

#### `sf_create_agent_action` / `sf_update_agent_action`
- Added `invocationTargetType` param (`"Flow"` | `"ApexClass"`, default `"Flow"`) — support for Apex class actions in addition to AutoLaunchedFlows
- Added `apexClassName` optional param — Apex class API name for ApexClass-backed actions
- `flowApiName` is now optional (required only when `invocationTargetType` is `"Flow"`)

#### `sf_create_agent_topic` / `sf_update_agent_topic`
- Added `escalationEnabled` optional boolean — sets `canEscalate` on the GenAiPlugin (allows human agent escalation)
- Added `fallbackTopic` optional string — API name of a fallback GenAiPlugin topic

#### `sf_create_agent_planner`
- Added `dataLibraryName` optional param — API name of a Data Library (Knowledge Base) for Knowledge-grounded agents

### New SOAP Helpers (internal)
- `readMetadataItem(type, fullName)` — SOAP readMetadata for a single component
- `listMetadataType(type)` — SOAP listMetadata for all components of a type
- `deleteMetadataItems(type, fullNames[])` — SOAP deleteMetadata for one or more components

---

## [2.1.3] - 2026-05-28

### Bug Fixes — Agentforce Action Invocation

This release fixes critical bugs that prevented Agentforce agents from invoking actions. Agents would correctly route to topics (TopicClassificationSuccess) but never call actions (no ActionExecuted events).

#### Root Cause: Missing GenAiFunction Schema Files

`sf_create_agent_action` was deploying GenAiFunction metadata without the required `input/schema.json` and `output/schema.json` bundle files. The Agentforce LLM runtime needs these JSON schemas to construct the tool call specification sent to the LLM. Without them, the LLM cannot invoke actions — it replies with messages like "I can't do that directly right now."

**Fix:** `sf_create_agent_action` now deploys a complete zip bundle containing:
- `genAiFunctions/<Name>/<Name>.genAiFunction-meta.xml`
- `genAiFunctions/<Name>/input/schema.json` — LLM-facing input parameter schema
- `genAiFunctions/<Name>/output/schema.json` — LLM-facing output parameter schema

Schema files use the correct Salesforce LightningTypeBundle format with `lightning:type`, `lightning:isPII`, `copilotAction:isUserInput`, `copilotAction:isDisplayable`, and `copilotAction:isUsedByPlanner` fields.

#### Flow Variable Type Mismatch Fixed

Flow variables of type `Currency`, `Number`, `Date`, and `DateTime` must use matching `lightning__numberType` or `lightning__dateType` in the schema, not `lightning__textType`. Using text type caused the LLM to send string values like `"5000"` which Flow rejected with "Amount field provided in incorrect format."

**Fix:** Added a `type` field to action parameters (`Text`, `Number`, `Currency`, `Boolean`, `Date`, `DateTime`, `TextArea`) that maps correctly to the corresponding `lightning:type` in the schema.

#### `sf_create_agent_topic` Was Creating Wrong Metadata Type

The tool was deploying `BotVersion` XML instead of `GenAiPlugin` XML.

**Fix:** Replaced `buildBotVersionXml` with `buildGenAiPluginXml` that produces correct `GenAiPlugin` metadata with `pluginType`, `scope`, `canEscalate`, step-by-step `genAiPluginInstructions`, and `genAiFunctions` references.

#### Added Missing Tools

- `sf_create_agent_planner` — Creates a `GenAiPlannerBundle` that links topics to the agent. This is the critical link between the Bot and its topics. Without it, the agent has 0 visible topics and cannot route any requests. Was missing entirely from v2.0.0.
- `sf_activate_agent` — Activates an agent via REST API after configuration changes.
- `sf_deactivate_agent` — Deactivates an agent (required before modifying topics/actions).

#### API Version Updated

Updated from `62.0` to `66.0` (current Salesforce API version for Agentforce metadata).

#### Schema Corrections (`sf_create_agent`)

- Removed invalid fields: `persona`, `tone`, `instructions`, `company` (not part of Bot metadata)
- Fixed `type` enum from `["Default", "EinsteinCopilot"]` to `["EinsteinCopilot", "ExternalCopilot"]`
- Added `agentTemplate: AiCopilot__AgentforceAgent` to Bot XML (required for proper action invocation wiring)

#### Correct Creation Order Now Enforced

The tool descriptions now document and enforce the correct metadata creation order:
1. Create Flows (`sf_create_flow`) — AutoLaunchedFlows with `runInMode=SystemModeWithoutSharing`
2. Create Actions (`sf_create_agent_action`) — GenAiFunction + schema files
3. Create Topics (`sf_create_agent_topic`) — GenAiPlugin referencing actions
4. Create Planner (`sf_create_agent_planner`) — GenAiPlannerBundle linking all topics
5. Create Agent (`sf_create_agent`) — Bot referencing the planner
6. Activate Agent (`sf_activate_agent`)

---

## [2.0.0] - 2026-05-22

### Major Release — 60+ Tools

This release transforms the server from a basic metadata tool into the most comprehensive Salesforce MCP server available.

### New Tools (53 additions)

#### Objects & Fields
- `sf_create_custom_metadata_type` — Create Custom Metadata Types (__mdt)
- `sf_create_custom_metadata_record` — Create records for Custom Metadata Types
- `sf_create_custom_label` — Create or update Custom Labels
- `sf_create_custom_setting` — Create Hierarchy or List Custom Settings
- `sf_create_global_value_set` — Create shared picklists (Global Value Sets)
- `sf_create_record_type` — Create Record Types with picklist mappings
- `sf_create_business_process` — Create Business Processes for Opp/Lead/Case
- `sf_create_page_layout` — Create Page Layouts with sections and related lists
- `sf_create_sharing_rule` — Create criteria and ownership sharing rules
- `sf_create_field_dependency` — Create controlling/dependent picklist relationships

#### Automation
- `sf_create_email_alert` — Create Workflow Email Alert actions
- `sf_create_platform_event` — Create Platform Event objects (__e)
- `sf_create_assignment_rule` — Create Lead/Case assignment rules
- `sf_create_escalation_rule` — Create Case escalation rules
- `sf_create_auto_response_rule` — Create auto-response rules for Web-to-Lead/Case
- `sf_create_matching_rule` — Create matching rules for duplicate detection
- `sf_create_duplicate_rule` — Create duplicate detection rules
- `sf_create_apex_email_service` — Create inbound email services
- `sf_create_scheduled_job` — Schedule Apex classes via cron expressions

#### Security & Access
- `sf_create_permission_set` — Create Permission Sets with full permissions config
- `sf_create_role` — Create roles in the role hierarchy
- `sf_create_queue` — Create queues with members and supported objects
- `sf_create_named_credential` — Create Named Credentials for callouts

#### UI & Experience
- `sf_create_lightning_app` — Create Lightning Apps with nav/utility bars
- `sf_create_tab` — Create Custom Tabs for objects
- `sf_create_compact_layout` — Create Compact Layouts
- `sf_create_list_view` — Create List Views with filters and columns
- `sf_create_email_template` — Create HTML/text email templates
- `sf_create_static_resource` — Deploy Static Resources from text content
- `sf_create_custom_notification_type` — Create Custom Notification Types
- `sf_create_report_type` — Create Custom Report Types
- `sf_create_dashboard` — Create Dashboards with components

#### Apex Development
- `sf_create_apex_class` — Deploy any Apex class via zip-based Metadata API
- `sf_create_apex_trigger` — Deploy Apex triggers
- `sf_create_apex_test_class` — Deploy test classes with optional auto-run
- `sf_run_apex_tests` — Run test classes and get pass/fail results
- `sf_execute_anonymous_apex` — Execute anonymous Apex via Tooling API

#### LWC Development
- `sf_create_lwc` — Deploy Lightning Web Components (HTML + JS + CSS)
- `sf_update_lwc` — Update existing LWC components

#### Experience Cloud
- `sf_create_experience_site` — Create Experience Cloud sites
- `sf_create_experience_page` — Create pages within Experience sites

#### Agentforce
- `sf_create_agent` — Create Agentforce Einstein Copilot agents
- `sf_create_agent_topic` — Create Agent Topics with instructions
- `sf_create_agent_action` — Create Agent Actions linked to Flows/Apex

#### External Integrations
- `sf_create_connected_app` — Create OAuth Connected Apps
- `sf_create_external_data_source` — Create External Data Sources
- `sf_create_external_object` — Create External Objects (__x)
- `sf_create_remote_site_setting` — Whitelist external URLs for callouts
- `sf_create_csp_setting` — Create CSP trusted sites

#### Change Sets & Deployment
- `sf_create_outbound_change_set` — Create Outbound Change Sets
- `sf_add_to_change_set` — Add components to change sets
- `sf_deploy_metadata` — Deploy metadata via SOAP Metadata API
- `sf_check_deploy_status` — Check deployment job status
- `sf_retrieve_metadata` — Retrieve metadata from the org

#### MCP Server Management
- `sf_create_mcp_server` — Generate new MCP server projects on disk
- `sf_create_mcp_tool` — Add tools to existing MCP servers
- `sf_list_mcp_tools` — List tools in an MCP server project

### Enhanced Tools
- `sf_create_flow` — Now supports advanced elements: Decision, GetRecords, CreateRecords, DeleteRecords, SendEmailAlert, ApexAction, Subflow, Loop, Assignment, Screen, Wait, Platform Event via `elements` array

### Infrastructure Changes
- Added `jszip` dependency for zip-based deployment (Apex, LWC, Static Resources)
- Split tools into category files: `objects.ts`, `automation.ts`, `security.ts`, `ui.ts`, `apex.ts`, `lwc.ts`, `experience.ts`, `agentforce.ts`, `deployment.ts`, `mcp.ts`, `integrations.ts`
- Added service modules: `deployment.ts` (zip/SOAP deploy), `tooling.ts` (Tooling API), `mcpgen.ts` (file generation)
- Updated server name to `salesforce-metadata-mcp`
- Updated API version to `62.0`
- Added HTTP transport health check endpoint

### Documentation
- Added `README.md` with all 60+ tools and example prompts
- Added `SETUP.md` with complete authentication setup guide
- Added `TOOLS.md` with full parameter documentation
- Added `AGENTFORCE.md` with end-to-end Agentforce guide
- Added `APEX_LWC.md` with Apex and LWC development guide

---

## [1.0.0] - 2025-01-01

### Initial Release

- `sf_create_custom_object` — Create custom objects
- `sf_create_custom_field` — Create custom fields (all types)
- `sf_add_picklist_values` — Add picklist values
- `sf_create_flow` — Create Flows (basic)
- `sf_create_approval_process` — Create Approval Processes
- `sf_create_validation_rule` — Create Validation Rules
- `sf_create_workflow_field_update` — Create Workflow Field Updates
