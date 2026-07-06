# salesforce-metadata-mcp — Project Context

## What this is
An open-source npm MCP server (package: salesforce-metadata-mcp, npm user: semwalajay83)
that lets Claude create and manage Salesforce metadata via natural language.
Currently at v2.5.2 with 207 tools.

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

## Known Bugs Pending Fix
- sf_create_flow: Loop elements cause HTTP 500
- sf_create_flow: Cross-variable filters use wrong XML type
- sf_create_flow: Contains operator not supported on GetRecords
- sf_create_flow: Decision elements generate incorrect XML
- sf_create_flow: No queriedFields, sortField, sortOrder, limit on GetRecords
- sf_deploy_metadata: Cannot accept inline XML from chat
- Missing tool: sf_create_flow_from_xml

## Claude Code Preferences
- Full autonomy, zero permission prompts
- Always run npm run build and fix errors before committing
- Always push to git after build succeeds
- NEVER run npm publish unless user explicitly asks
