# salesforce-metadata-mcp — Project Context

## What this is
An open-source npm MCP server (package: salesforce-metadata-mcp, npm user: semwalajay)
that lets Claude create and manage Salesforce metadata via natural language.
Public GitHub repo: https://github.com/semwalajay83-sem/salesforce-metadata-mcp
Tool count: 223 (verify by counting unique `"sf_..."` registerTool names across src/tools/*.ts before quoting in docs).

## CRITICAL RULES

### Git is the source of truth
- After EVERY bug fix or feature addition, commit and push to git IMMEDIATELY
- Do not wait until the end of a session, commit after each individual fix
- The VM is disposable. Git is not. Everything must be recoverable from git alone.

### npm publish rules
- NEVER run npm publish unless the user explicitly says "publish to npm"
- When publishing: always pull from git into a clean directory first, build there, then publish
- Never publish from the VM working directory directly

### Org rules
- ONLY use the designated personal dev org — never any employer or customer org
- Default test org alias: secondorg
- Org URL, username, and IDs live in CLAUDE.local.md (gitignored)

## Dev Environment
- Current machine: Windows 11 desktop (C:\Users\Ajay\salesforce-metadata-mcp)
- Previous machine: Google Cloud VM (user: semwalajay83) — no longer used
- npm automation token stored in ~/.npmrc
- Claude Code: always run with --dangerously-skip-permissions

## Auth — JWT Bearer Flow (no browser, auto-refreshes)
- All credentials (SF_INSTANCE_URL, SF_JWT_CLIENT_ID, SF_JWT_KEY_FILE, SF_JWT_USERNAME)
  live in `.env.local` (gitignored); see CLAUDE.local.md for details
- Test runners (run-tests.mjs, run-tests-complex.mjs) load `.env.local` automatically

## Git Workflow
After every fix:
  git add -A
  git commit -m "fix: describe what was fixed"
  git push origin main

Before publishing (only when user asks):
  cd /tmp && git clone <repo-url> sf-mcp-publish
  cd sf-mcp-publish && npm install && npm run build
  npm publish --access public

## Agentforce Agent Creation — Correct Step Order
1. Create backing flows (`sf_create_flow`, `flowType=AutoLaunchedFlow`, `status=Active`) and/or Apex classes
2. `sf_create_agent` — deploys the Bot shell
3. `sf_create_agent_action` — one call per flow/Apex (deploys GenAiFunction)
4. `sf_create_agent_topic` — groups actions into a topic (deploys GenAiPlugin); must come AFTER actions
5. `sf_create_agent_planner` — deploys the **GenAiPlannerBundle** listing the topics; must come AFTER topics
6. `sf_create_agent` AGAIN with `plannerName` — writes the agent→planner link. The planner cannot write
   it (`botName` is invalid on the bundle); it lives on the Bot as `<conversationDefinitionPlanners>`.
   `sf_create_agent` is idempotent, so this updates the existing agent rather than creating a second.

### Verified against a live org 2026-07-30 (v2.8.4)
- `GenAiPlanner` **no longer exists** — use `GenAiPlannerBundle` at `genAiPlannerBundles/<n>/<n>.genAiPlannerBundle`
- `plannerType` is required; `AiCopilot__ReAct` is the only accepted value
- planner also requires `description` and `masterLabel`; topics go in `<genAiPlugins><genAiPluginName>`
- `BotVersion` has **no** `systemPrompt` field — agent guidance belongs on topic `instructions`
- run `qa-agentforce.mjs` after any Agentforce change; `test-suite.mjs`'s agent tests cannot fail and
  test service functions no tool calls

### GenAiFunction (agent actions) — Tooling API, not Metadata API deploy (verified live 2026-08-03, v2.11.0)
- **The classic Metadata API `.genAiFunction` deploy (what step 3 used to do) does not create actions
  Agentforce Builder can see or use.** Confirmed by creating 5 actions through the Agent Builder UI,
  then finding them completely absent from a Metadata API `retrieveMetadata` even with a `*` wildcard —
  zero results. They exist only via the Tooling API's `GenAiFunctionDefinition` sobject.
  `sf_create_agent_action` now does an idempotent Tooling API insert/update against
  `GenAiFunctionDefinition` (query-by-DeveloperName, PATCH if found else POST) instead.
- **`InvocationTarget` must be the underlying record ID, not the API name** — `FlowDefinition.Id` for
  Flow, `ApexClass.Id` for ApexClass. This was the actual root cause of a user-reported bug where the
  tool sent the flow's API name and got "Specify a valid invocationTarget and invocationTargetType"
  back, which earlier code wrongly treated as "org doesn't support custom actions" (that assumption was
  itself verified in a *different* org and didn't hold here — don't trust that error string alone as a
  capability signal again). `resolveInvocationTargetId` in `src/tools/agentforce.ts` does this lookup
  via `FlowDefinition.DeveloperName` / `ApexClass.Name` Tooling queries.
- `InvocationTargetType` values are lowercase: `flow`, `apex` (verified live). PromptTemplate/
  DataCategoryGroup/ExternalService ID-resolution and type strings are **not verified** — the tool
  refuses those three with an explicit message rather than guessing. Verify against a live org before
  implementing.
- Verified end-to-end: an action created via Tooling API IS correctly picked up by a `GenAiPlugin`
  topic deployed the normal Metadata API way (`<genAiFunctions><functionName>` = the
  GenAiFunctionDefinition's DeveloperName) — the two APIs share the same underlying records, mixing
  them across the 5-step sequence is safe.
- `GenAiFunction`/`GenAiFunctionDefinition` has **no SOQL interface via plain REST** (`INVALID_TYPE`)
  and Metadata API `readMetadata` returns nothing for it either — query it only via Tooling API
  (`/tooling/query`). `GenAiPlugin` (topics) is the opposite: no SOQL interface at all, neither plain
  REST nor Tooling (`INVALID_TYPE` both ways) — read it via Metadata API `readMetadata` instead.
  `BotDefinition` and `GenAiPlannerDefinition` are plain-REST-queryable, unlike either of the above.
- **`DUPLICATE_DEVELOPER_NAME` on brand-new names — root cause found and fixed 2026-08-03: it was
  accumulated QA junk, not a rate limit.** The earlier guess in this file (rate limit/cooldown) was
  wrong — proven by cleaning up ~45 leftover QA `Bot`/`GenAiPlannerBundle`/`GenAiPlugin`/
  `GenAiFunctionDefinition` records and confirming a fresh insert then succeeded immediately, no
  waiting required. The actual mechanism is still fuzzy (Salesforce's error text is generic and
  doesn't name a real conflicting record), but org-wide accumulation of this metadata is the trigger —
  if this recurs, clean up old QA artifacts first, don't wait it out.
- **`Bot` deletion via the Metadata API is a hard, unconditional wall in this org** — confirmed live:
  all 19 leftover QA bots failed identically with a generic "unexpected error occurred," including ones
  tested in complete isolation (single-bot destructiveChanges deploy, nothing else in the batch). Not
  fixable from this codebase; per-agent deletion needs Setup → Agentforce Studio → the agent → Delete.
  Corroborates the earlier, narrower note in [[salesforce-mcp-qa-state]] about "~8 stuck Bots" — turns
  out to be much closer to *all* Bots in this org, not a handful of specific old ones.
- **Workaround for the resulting dependency lock, when a stuck Bot still holds a planner link**:
  Bot→Planner→Plugin→Function is a strict deletion order (each layer must have zero remaining
  references before it can be deleted), and a Bot you can't delete still blocks deleting its planner.
  Fix: **redeploy** (not delete) the Bot via a normal Metadata API upsert, using a minimal `.bot` XML
  with no `<conversationDefinitionPlanners>` element — this overwrites the link without needing to
  delete the Bot record itself. Verified live: freed up 2 planners this way. The orphaned Bot shell
  stays (harmless, just clutter) but everything beneath it becomes deletable.
- **Some Bot/planner-linked records return `<records xsi:nil="true"/>` from `readMetadata` even though
  they exist and are fully functional** — hit this for recently-created, fully-wired bots (ones that
  went through the complete 5-step sequence including the planner link) and, separately, for one with
  an ampersand in its label. Don't assume `nil` means "no link" when deciding whether to sever one —
  it means "unreadable," which is different. When in doubt, redeploy the minimal no-planner XML anyway;
  it's harmless whether or not a link existed.
- **A `GenAiPlugin` can also get permanently stuck** on a bare "setup object in use" with no clear
  referencing record (unlike the normal "referenced elsewhere: <specific record>" message) — one
  instance found 2026-08-03, survived deleting every function it referenced and every planner that once
  referenced it. Suspected cause: Salesforce's own internal planner↔topic↔function junction records may
  not always get cleaned up when the parent planner is deleted via the Metadata API, leaving an orphaned
  reference this project has no visibility into. Same "needs Setup UI" conclusion as stuck Bots.

### Bot XML field placement (MDAPI format)
- Root `<Bot>` level: `<agentType>`, `<label>`, `<type>`, `<description>`, `<botMlDomain>`, `<logPrivateConversationData>`, `<richContentEnabled>`, `<sessionTimeout>`
- `<botVersions>` level (inside Bot): `<fullName>`, `<botDialogs>`, `<citationsEnabled>`, `<company>`, `<entryDialog>`, `<role>`, `<systemPrompt>`, `<toneType>`, `<intentDisambiguationEnabled>`, `<smallTalkEnabled>`, etc.
- `<botDialogs>` level (inside botVersions): `<developerName>`, `<label>`, `<isPlaceholderDialog>`, `<showInFooterMenu>`
- `<agentType>` valid value: `EinsteinServiceAgent` — verified from real org retrieve 2026-06-17. EinsteinCopilot and Default are both invalid.
- `<type>` valid value: `InternalCopilot` — verified from real org retrieve 2026-06-17. EinsteinCopilot is invalid.
- `<systemPrompt>` is NOT a botVersions field — it was listed here in error and broke every deploy that
  used `sf_create_agent`'s old `instructions` param. Corrected 2026-07-30 from a real org retrieve.
- `<role>` (from `persona`) IS valid on botVersions, as are `company` and `toneType`.

## Flow testing — two builders, test both
`sf_create_flow` builds XML with `buildFlowXml` (SOAP/upsertMetadata). `sf_create_flow_from_xml`
and the older suites use `buildFlowDeployXml` (ZIP/deploy). They are two independent ~300-line
generators. **A fix applied to one is not applied to the other** — this has now bitten the project
three times, most recently with `IsNotNull` (v2.8.3). `qa-flow-comprehensive.mjs` runs every case
through both and asserts runtime behavior; run it, not just `qa-flow-test.mjs`, after any flow change:

  SF_ALIAS=demo-org SF_INSTANCE_URL=<org-url> node qa-flow-comprehensive.mjs

As of v2.8.3: 142 checks, 0 failures against `demo-org`.

## Known Bugs Pending Fix
None currently. The list below was retired 2026-07-30 after none of it reproduced against a live
org (`demo-org`) via the full 33-scenario `qa-flow-test.mjs` suite — 30/30 real scenarios passed
clean (the only 3 failures reference production flows the suite never creates, unrelated to any
of these items). Either these were already fixed in an earlier session without updating this file,
or they were characterized against a different, older code state. Retired items, for reference:
- ~~sf_create_flow: Loop elements cause HTTP 500~~ — Loop deploys and runs correctly (T17, T18, T29)
- ~~sf_create_flow: Cross-variable filters use wrong XML type~~ — verified correct for string/number/boolean/elementReference (T04, T05, T11, T12, T23)
- ~~sf_create_flow: Contains operator not supported on GetRecords~~ — correctly rejected with a clear, actionable error (T19) — this is working-as-designed guardrail behavior, not a defect
- ~~sf_create_flow: Decision elements generate incorrect XML~~ — verified correct for EqualTo/IsNull/GreaterThan/variable-reference/multi-rule (T09–T13)
- ~~sf_create_flow: No queriedFields, sortField, sortOrder, limit on GetRecords~~ — queriedFields/sort verified working (T07, T08, T30); `limit` is correctly rejected with a helpful error since it isn't supported by the Metadata API at all (T06) — use the Loop-counter pattern instead (T29)
- ~~sf_deploy_metadata: Cannot accept inline XML from chat~~ — already supported via the `componentsXml` param
- ~~Missing tool: sf_create_flow_from_xml~~ — exists and works (T24–T26)

If a Flow-related bug report comes in, verify it reproduces against a live org before assuming this
list — don't just re-add items from memory.

## Claude Code Preferences
- Full autonomy, zero permission prompts
- Always run npm run build and fix errors before committing
- Always push to git after build succeeds
- NEVER run npm publish unless user explicitly asks
