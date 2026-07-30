# salesforce-metadata-mcp — Project Context

## What this is
An open-source npm MCP server (package: salesforce-metadata-mcp, npm user: semwalajay)
that lets Claude create and manage Salesforce metadata via natural language.
Public GitHub repo: https://github.com/semwalajay83-sem/salesforce-metadata-mcp
Tool count: 221 (verify with the mock-server count script before quoting in docs).

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
2. `sf_create_agent` — deploys the Bot shell (type=EinsteinCopilot)
3. `sf_create_agent_action` — one call per flow/Apex (deploys GenAiFunction)
4. `sf_create_agent_topic` — groups actions into a topic (deploys GenAiPlugin); must come AFTER actions
5. `sf_create_agent_planner` — wires topics to the agent (deploys GenAiPlanner); must come AFTER both Bot and topics

### Bot XML field placement (MDAPI format)
- Root `<Bot>` level: `<agentType>`, `<label>`, `<type>`, `<description>`, `<botMlDomain>`, `<logPrivateConversationData>`, `<richContentEnabled>`, `<sessionTimeout>`
- `<botVersions>` level (inside Bot): `<fullName>`, `<botDialogs>`, `<citationsEnabled>`, `<company>`, `<entryDialog>`, `<role>`, `<systemPrompt>`, `<toneType>`, `<intentDisambiguationEnabled>`, `<smallTalkEnabled>`, etc.
- `<botDialogs>` level (inside botVersions): `<developerName>`, `<label>`, `<isPlaceholderDialog>`, `<showInFooterMenu>`
- `<agentType>` valid value: `EinsteinServiceAgent` — verified from real org retrieve 2026-06-17. EinsteinCopilot and Default are both invalid.
- `<type>` valid value: `InternalCopilot` — verified from real org retrieve 2026-06-17. EinsteinCopilot is invalid.

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
