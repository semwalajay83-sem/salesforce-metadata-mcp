import JSZip from "jszip";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CreateAgentSchema, CreateAgentTopicSchema, CreateAgentActionSchema, CreateAgentPlannerSchema } from "../schemas/index.js";
import { getAuth, x, API_VERSION, deleteMetadataItems, readMetadataItem } from "../services/salesforce.js";
import { buildGenericDeployZip, deployZip, pollDeployStatus } from "../services/deployment.js";
import { resultContent } from "./utils.js";
import type { SalesforceAuth } from "../types.js";

const SF_NS = "http://soap.sforce.com/2006/04/metadata";

// "Specify a valid invocationTarget and invocationTargetType" is what Salesforce returns BOTH for a
// genuinely bad target AND for "custom agent actions aren't enabled in this org at all" — confirmed
// live (2026-07-30 session, re-confirmed by a user report 2026-08-01) by pointing a GenAiFunction at
// a deliberately nonexistent flow: an org where actions ARE supported gives a specific, different
// error (e.g. naming the missing flow); an org where the capability itself is off gives this exact
// generic message regardless of target validity. That makes it a reliable capability signal — unlike
// checking for the Agentforce permission set licenses, which a live org confirmed can be fully active
// while custom actions are still unsupported (licensing is not sufficient evidence either way).
const CAPABILITY_DISABLED_MESSAGE = /Specify a valid invocationTarget and invocationTargetType/i;

/**
 * Probes whether this org can create GenAiFunction (custom agent action) records at all, before
 * sf_create_agent commits to creating a Bot shell that step 2 of the 5-step sequence can never
 * complete. Deploys a real, throwaway GenAiFunction aimed at a name that cannot exist, then reads the
 * failure message to tell "capability disabled" apart from "target doesn't exist" (see
 * CAPABILITY_DISABLED_MESSAGE above) — cleans up after itself either way, so this never leaves an
 * orphan of its own. Found necessary 2026-08-01: a user's agent shell was left stranded in the org
 * with no planner/topic/action once step 2 turned out to be unreachable, and there was no earlier
 * point in the sequence that could have caught this.
 */
async function probeAgentActionCapability(auth: SalesforceAuth): Promise<{ supported: boolean; detail: string }> {
  const probeName = `QA_Capability_Probe_${Date.now().toString(36)}`;
  const probeXml = `<?xml version="1.0" encoding="UTF-8"?>
<GenAiFunction xmlns="${SF_NS}">
  <description>Capability probe — safe to delete if found; created and removed automatically by sf_create_agent.</description>
  <developerName>${x(probeName)}</developerName>
  <invocationTarget>__Nonexistent_Probe_Target_${Date.now().toString(36)}__</invocationTarget>
  <invocationTargetType>flow</invocationTargetType>
  <isConfirmationRequired>false</isConfirmationRequired>
  <masterLabel>${x(probeName)}</masterLabel>
</GenAiFunction>`;
  try {
    const base64Zip = await buildGenericDeployZip([], API_VERSION, [{ type: "GenAiFunction", name: probeName, xml: probeXml }]);
    const deployId = await deployZip(auth, base64Zip, { rollbackOnError: true });
    const result = await pollDeployStatus(auth, deployId, 2 * 60 * 1000);
    if (result.success) {
      // Unexpected (a nonexistent target should never deploy clean), but if it did, the capability
      // clearly exists — clean up the probe and don't block anything.
      await deleteMetadataItems(auth, "GenAiFunction", [probeName]).catch(() => null);
      return { supported: true, detail: "probe deployed unexpectedly; capability confirmed" };
    }
    const message = result.message ?? "";
    if (CAPABILITY_DISABLED_MESSAGE.test(message)) {
      return { supported: false, detail: message };
    }
    // Any other failure (e.g. naming the specific missing target) means the org DID attempt target
    // resolution — the capability exists, this probe just used a deliberately invalid target.
    return { supported: true, detail: message };
  } catch (err) {
    // If the probe itself can't be attempted, don't block agent creation on an inconclusive result —
    // fail open rather than blocking a capability check that couldn't run for an unrelated reason.
    return { supported: true, detail: `probe inconclusive: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function buildBotDeployZip(params: {
  agentName: string; label: string; description?: string;
  company?: string; tone?: string; role?: string; plannerName?: string; apiVersion: string;
}): Promise<string> {
  // MDAPI format: BotVersion is embedded as <botVersions> inside the single .bot file
  // Ground truth values retrieved from real org (2026-06-17, re-verified 2026-07-30):
  //   agentType = EinsteinServiceAgent (BotType enum; EinsteinCopilot and Default are both invalid)
  //   type      = InternalCopilot      (GenAiAgentType enum; EinsteinCopilot is invalid)
  // BotVersion has NO systemPrompt field — deploying one fails with "Element systemPrompt invalid
  // at this location in type BotVersion". Agent guidance belongs on the topics
  // (sf_create_agent_topic's `instructions`), not on the Bot. <role> is the valid persona field.
  const botXml = `<?xml version="1.0" encoding="UTF-8"?>
<Bot xmlns="${SF_NS}">
  <agentType>EinsteinServiceAgent</agentType>
  <botMlDomain>
    <label>${x(params.label)}</label>
    <name>${x(params.agentName)}</name>
  </botMlDomain>
  <botVersions>
    <fullName>v1</fullName>
    <botDialogs>
      <developerName>Welcome</developerName>
      <isPlaceholderDialog>false</isPlaceholderDialog>
      <label>Welcome</label>
      <showInFooterMenu>false</showInFooterMenu>
    </botDialogs>
    <citationsEnabled>false</citationsEnabled>
    ${params.company ? `<company>${x(params.company)}</company>` : ""}
    ${params.plannerName ? `<conversationDefinitionPlanners><genAiPlannerName>${x(params.plannerName)}</genAiPlannerName></conversationDefinitionPlanners>` : ""}
    <entryDialog>Welcome</entryDialog>
    <intentDisambiguationEnabled>false</intentDisambiguationEnabled>
    <intentV3Enabled>false</intentV3Enabled>
    <knowledgeActionEnabled>false</knowledgeActionEnabled>
    <knowledgeFallbackEnabled>false</knowledgeFallbackEnabled>
    ${params.role ? `<role>${x(params.role)}</role>` : ""}
    <smallTalkEnabled>false</smallTalkEnabled>
    <toneType>${x(params.tone ?? "Neutral")}</toneType>
  </botVersions>
  ${params.description ? `<description>${x(params.description)}</description>` : ""}
  <label>${x(params.label)}</label>
  <logPrivateConversationData>false</logPrivateConversationData>
  <richContentEnabled>true</richContentEnabled>
  <sessionTimeout>0</sessionTimeout>
  <type>InternalCopilot</type>
</Bot>`;

  const packageXml = `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="${SF_NS}">
  <types>
    <members>${x(params.agentName)}</members>
    <name>Bot</name>
  </types>
  <version>${x(params.apiVersion)}</version>
</Package>`;

  const zip = new JSZip();
  zip.file("package.xml", packageXml);
  zip.file(`bots/${params.agentName}.bot`, botXml);
  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  return buffer.toString("base64");
}

export function registerAgentforceTools(server: McpServer): void {

  server.registerTool(
    "sf_create_agent",
    {
      title: "Create Agentforce Agent",
      description: `Creates an Agentforce Agent (Einstein Copilot) shell in Salesforce. THIS IS STEP 1 OF A 5-STEP SEQUENCE — calling this tool alone produces a non-functional agent shell. You MUST continue calling tools in this exact order without stopping: (0) FIRST create the backing flows (sf_create_flow, flowType=AutoLaunchedFlow, status=Active) and/or Apex classes (sf_create_apex_class with @InvocableMethod) for each capability. (1) THIS TOOL — sf_create_agent. (2) sf_create_agent_action — one call per flow/apex. (3) sf_create_agent_topic — group actions into topics; pass all action API names in the 'actions' array. (4) sf_create_agent_planner — wire topics to the agent. DO NOT report completion to the user until sf_create_agent_planner succeeds. Do not ask the user for confirmation between steps — proceed through all steps autonomously. On the first call (no plannerName), this tool probes whether the org can create custom agent actions at all before creating the shell — if it can't, this call fails with no shell created, rather than leaving an orphaned Bot with no planner/topic/action once step 2 turns out to be unreachable. Active Agentforce permission set licenses do NOT guarantee this probe passes — those are a separate signal, confirmed live to be an unreliable one. Pass skipActionCapabilityCheck:true only for a topics-only agent (no custom actions planned) or when you already know the answer.`,
      inputSchema: CreateAgentSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      try {
        // Only probe on the first call in the 5-step sequence (plannerName is only ever passed on the
        // final, step-5 call to write the agent→planner link) — no point re-probing once the shell,
        // and possibly actions/topics/planner, already exist. Found necessary 2026-08-01: without this,
        // a org that can't create GenAiFunction actions at all still gets a Bot shell created here,
        // then fails at step 2 with no way back — the shell is left permanently orphaned (no planner,
        // no topic, no action) since there's no rollback across this 5-call sequence.
        if (!params.plannerName && !params.skipActionCapabilityCheck) {
          const capability = await probeAgentActionCapability(auth);
          if (!capability.supported) {
            return resultContent({
              success: false,
              message: `Not creating agent '${params.agentName}' yet: this org cannot create custom agent actions (GenAiFunction) — confirmed via a real probe deploy just now, not assumed. Proceeding would create the Bot shell, then fail at step 2 (sf_create_agent_action) and leave that shell permanently orphaned with no planner/topic/action, since this 5-step sequence has no rollback. IMPORTANT: this is NOT the same signal as the Agentforce permission set licenses being active — a live org confirmed those can be fully active while custom actions are still unsupported, so don't treat active PSLs as proof this will work. If the agent genuinely doesn't need any custom actions (topics with instructions/knowledge only, no Flow/Apex-backed actions), that IS supported here — call sf_create_agent again with the same arguments plus skipActionCapabilityCheck: true to bypass this probe and proceed with a topics-only agent. Otherwise, this needs Setup → Agentforce → Agent Actions (or equivalent licensing) enabled first. Salesforce's own detail: ${capability.detail}`,
            });
          }
        }
        const base64Zip = await buildBotDeployZip({
          agentName: params.agentName,
          label: params.label ?? params.agentName,
          description: params.description,
          company: params.company,
          tone: params.tone,
          role: params.persona,
          plannerName: params.plannerName,
          apiVersion: API_VERSION,
        });
        const deployId = await deployZip(auth, base64Zip, { rollbackOnError: true });
        const result = await pollDeployStatus(auth, deployId, 10 * 60 * 1000);
        if (!result.success) return resultContent({ ...result, message: `Agent deployment failed. Common causes: (1) Agentforce/Einstein Copilot is not enabled in this org — enable it in Setup → Agentforce, (2) agentName contains invalid characters — use letters and numbers only, no underscores, (3) Developer Edition orgs may lack Einstein features. Salesforce error: ${result.message ?? JSON.stringify(result)}` });
        if (params.plannerName) {
          return resultContent({ success: true, fullName: params.agentName, created: true, message: `Agent '${params.agentName}' updated and linked to planner '${params.plannerName}'. The agent→planner wiring is now complete. Activate the agent in Setup → Agentforce to make it live.` });
        }
        return resultContent({ success: true, fullName: params.agentName, created: true, message: `Agent shell '${params.agentName}' created (step 1 of 5 complete). THE AGENT IS NOT FUNCTIONAL YET — do not report success to the user. REQUIRED NEXT ACTIONS (call these tools now, in order, without stopping): [2] sf_create_agent_action — one call per flow or Apex action. [3] sf_create_agent_topic — pass ALL action API names in the 'actions' array. [4] sf_create_agent_planner — deploys the planner. [5] sf_create_agent again with agentName='${params.agentName}' and plannerName='${params.agentName}' — writes the agent→planner link, which lives on the Bot and cannot be set by the planner itself. Only after step 5 is the agent usable. Proceed immediately.` });
      } catch (err: unknown) {
        return resultContent({ success: false, message: `Agent creation error: ${err instanceof Error ? err.message : String(err)}. Check that Agentforce is enabled in your org (Setup → Agentforce).` });
      }
    }
  );

  server.registerTool(
    "sf_create_agent_topic",
    {
      title: "Create Agentforce Topic",
      description: `Creates a Topic (GenAiPlugin) for an Agentforce Agent — step 3 of the agent setup sequence. Call this AFTER all actions have been created with sf_create_agent_action. CRITICAL: pass ALL action API names in the 'actions' array — omitting it creates a topic with no executable actions and the agent silently does nothing. agentName is informational only (not written to XML) — the actual agent→topic wiring happens in sf_create_agent_planner which you MUST call immediately after this step. Do not stop between steps.`,
      inputSchema: CreateAgentTopicSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      try {
        // Salesforce's own error for a topic referencing a missing action is an opaque support
        // ErrorId ("An unexpected error occurred..."), not anything naming the missing action —
        // confirmed live 2026-08-01. GenAiFunction isn't SOQL/Tooling-queryable in every org (it
        // isn't in this one), so existence is checked via Metadata API readMetadata instead, which
        // works regardless of SOQL support for the type.
        const missingActions: string[] = [];
        for (const actionName of params.actions ?? []) {
          const read = await readMetadataItem(auth, "GenAiFunction", actionName).catch(() => null);
          if (!read?.success || /records xsi:nil="true"/.test(read.rawXml ?? "")) missingActions.push(actionName);
        }
        if (missingActions.length > 0) {
          return resultContent({ success: false, message: `Not deploying topic '${params.topicName}': the following action(s) in 'actions' don't exist yet — ${missingActions.join(", ")}. Create them first with sf_create_agent_action, then retry. (Salesforce's own error for this — an opaque support ErrorId with no indication which action is missing — is why this is checked here first.)` });
        }
        const instructionsXml = (Array.isArray(params.instructions) ? params.instructions : (params.instructions ? [params.instructions] : [])).map((instr: string, i: number) => `
  <genAiPluginInstructions>
    <description>${x(instr)}</description>
    <developerName>instruction_${i}</developerName>
    <masterLabel>instruction_${i}</masterLabel>
    <sortOrder>${i}</sortOrder>
  </genAiPluginInstructions>`).join("\n");
        const functionsXml = (params.actions ?? []).map((a: string) => `
  <genAiFunctions>
    <functionName>${x(a)}</functionName>
  </genAiFunctions>`).join("\n");
        const pluginXml = `<?xml version="1.0" encoding="UTF-8"?>
<GenAiPlugin xmlns="${SF_NS}">
  <description>${x(params.description)}</description>
  <developerName>${x(params.topicName)}</developerName>
  ${instructionsXml}
  ${functionsXml}
  <language>en_US</language>
  <masterLabel>${x(params.label ?? params.topicName)}</masterLabel>
  <pluginType>Topic</pluginType>
  <scope>${x(params.scope ?? params.description)}</scope>
</GenAiPlugin>`;
        const base64Zip = await buildGenericDeployZip([], API_VERSION, [{ type: "GenAiPlugin", name: params.topicName, xml: pluginXml }]);
        const deployId = await deployZip(auth, base64Zip, { rollbackOnError: true });
        const result = await pollDeployStatus(auth, deployId, 10 * 60 * 1000);
        if (!result.success) return resultContent({ ...result, message: `Topic deployment failed. Check that: (1) all action API names in the 'actions' array already exist in the org (created via sf_create_agent_action), (2) topicName uses only letters/numbers/underscores. Salesforce error: ${result.message ?? JSON.stringify(result)}` });
        const actionsLinked = (params.actions ?? []).length;
        return resultContent({ success: true, fullName: params.topicName, created: true, message: `Topic '${params.topicName}' created with ${actionsLinked} action(s) linked${actionsLinked === 0 ? " — WARNING: no actions were linked, the agent will do nothing for this topic. Re-create the topic and pass the action API names in the 'actions' array." : ""}. DO NOT STOP — the agent still cannot route requests. REQUIRED NEXT: call sf_create_agent_planner now with agentName='${params.agentName}' and topicNames=['${params.topicName}'] (plus any other topics). This is the final mandatory step — proceed immediately.` });
      } catch (err: unknown) {
        return resultContent({ success: false, message: `Topic creation error: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
  );

  server.registerTool(
    "sf_create_agent_planner",
    {
      title: "Wire Agent to Topics — Final Step (Create GenAiPlanner)",
      description: `Creates a GenAiPlanner that connects an Agentforce Agent (Bot) to its Topics — STEP 4 (FINAL) of the agent setup sequence. Without this step the agent cannot route ANY request regardless of how many topics and actions were created. Also known as: linking topics to agent, connecting topics, finishing agent setup, wiring topics, registering topics. CRITICAL: topicNames must be the COMPLETE list of all topics — this REPLACES any existing planner, so omitting a topic removes it from the agent. When adding a new topic to an existing agent, include ALL previous topic names plus the new one. Only AFTER this step succeeds should you report completion to the user.`,
      inputSchema: CreateAgentPlannerSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      try {
        // GenAiPlanner no longer exists — Salesforce replaced it with GenAiPlannerBundle and rejects
        // the old type with "Not available for deploy for this API version". Field set verified
        // against a live org (2026-07-30): description, masterLabel and plannerType are all required,
        // AiCopilot__ReAct is the only accepted PlannerType, topics go in <genAiPlugins> as
        // <genAiPluginName>, and <botName> is invalid here — the agent→planner link lives on the Bot
        // (BotVersion <conversationDefinitionPlanners>), which sf_create_agent writes via plannerName.
        const topicFunctionsXml = params.topicNames.map(t => `
  <genAiPlugins>
    <genAiPluginName>${x(t)}</genAiPluginName>
  </genAiPlugins>`).join("");
        const actionFunctionsXml = (params.actionNames ?? []).map(a => `
  <genAiFunctions>
    <genAiFunctionName>${x(a)}</genAiFunctionName>
  </genAiFunctions>`).join("");
        const plannerXml = `<?xml version="1.0" encoding="UTF-8"?>
<GenAiPlannerBundle xmlns="${SF_NS}">
  <description>${x(params.description ?? `Planner for agent ${params.agentName}`)}</description>
  <masterLabel>${x(params.label ?? params.agentName)}</masterLabel>
  <plannerType>AiCopilot__ReAct</plannerType>${topicFunctionsXml}${actionFunctionsXml}
</GenAiPlannerBundle>`;
        const base64Zip = await buildGenericDeployZip([], API_VERSION, [{ type: "GenAiPlannerBundle", name: params.agentName, xml: plannerXml }]);
        const deployId = await deployZip(auth, base64Zip, { rollbackOnError: true });
        const result = await pollDeployStatus(auth, deployId, 10 * 60 * 1000);
        if (!result.success) return resultContent({ ...result, message: `Planner deployment failed. Check that: (1) agentName matches an existing Bot/agent in the org, (2) all topicNames exist in the org (created via sf_create_agent_topic). Salesforce error: ${result.message ?? JSON.stringify(result)}` });
        return resultContent({ success: true, fullName: params.agentName, created: true, message: `Planner '${params.agentName}' deployed with topics: ${params.topicNames.join(", ")}. ONE STEP REMAINS — the agent is not linked to this planner yet: call sf_create_agent again with agentName='${params.agentName}' and plannerName='${params.agentName}' to write the link (that tool is idempotent, so it updates the existing agent rather than creating a second one). After that, activate the agent in Setup → Agentforce to make it live.` });
      } catch (err: unknown) {
        return resultContent({ success: false, message: `Planner creation error: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
  );

  server.registerTool(
    "sf_create_agent_action",
    {
      title: "Create Agentforce Action",
      description: `Creates an Agentforce Action (GenAiFunction) — step 2 of the agent setup sequence. Call this once per capability (once per flow, once per Apex class). IMPORTANT by type: For Flow — the flow must already exist as an Active AutoLaunchedFlow (use sf_create_flow with flowType='AutoLaunchedFlow' and status='Active' first). For ApexClass — the class must already exist AND have @InvocableMethod (use sf_create_apex_class first). The 'reference' is the exact API name of the flow or class. After ALL actions are created, call sf_create_agent_topic (passing all action API names in 'actions' array), then sf_create_agent_planner. Do not stop between steps.`,
      inputSchema: CreateAgentActionSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      try {
        const fullName = params.actionName;
        const typeMap: Record<string, string> = {
          Flow: "flow",
          ApexClass: "apex",
          PromptTemplate: "promptTemplate",
          DataCategoryGroup: "dataCategoryGroup",
          ExternalService: "externalService",
        };
        const invTargetType = typeMap[params.type ?? "Flow"] ?? (params.type ?? "flow").toLowerCase();
        const functionXml = `<?xml version="1.0" encoding="UTF-8"?>
<GenAiFunction xmlns="${SF_NS}">
  <description>${x(params.description)}</description>
  <developerName>${x(params.actionName)}</developerName>
  <invocationTarget>${x(params.reference)}</invocationTarget>
  <invocationTargetType>${x(invTargetType)}</invocationTargetType>
  <isConfirmationRequired>false</isConfirmationRequired>
  <masterLabel>${x(params.label ?? params.actionName)}</masterLabel>
</GenAiFunction>`;
        const base64Zip = await buildGenericDeployZip([], API_VERSION, [{ type: "GenAiFunction", name: fullName, xml: functionXml }]);
        const deployId = await deployZip(auth, base64Zip, { rollbackOnError: true });
        const result = await pollDeployStatus(auth, deployId, 10 * 60 * 1000);
        if (!result.success) {
          // "Specify a valid invocationTarget and invocationTargetType" is also what Salesforce
          // returns when GenAiFunction creation is not enabled in the org at all — verified on a
          // live org where every documented target type, including standard invocable actions,
          // was rejected identically against a confirmed-Active flow and Apex class. Say so, rather
          // than sending the caller to re-check a flow that is already fine.
          const targetErr = /Specify a valid invocationTarget/i.test(result.message ?? "");
          return resultContent({ ...result, message: `Action deployment failed. Check that: (1) for Flow type — the flow '${params.reference}' exists and is Active (not Draft), (2) for ApexClass type — the class '${params.reference}' exists and has @InvocableMethod annotation, (3) actionName contains only letters/numbers/underscores.${targetErr ? ` NOTE: if '${params.reference}' is confirmed to exist and be active, this same error means custom agent actions are not enabled in this org — GenAiFunction appears in the metadata type list but rejects every invocationTargetType. Check your Agentforce/Einstein licensing in Setup rather than the target.` : ""} Salesforce error: ${result.message ?? JSON.stringify(result)}` });
        }
        // params.inputs (input parameter mappings) is accepted by the schema but was never wired into
        // functionXml above — confirmed by grep, not an oversight in this pass, a pre-existing gap
        // found during the 2026-07-31 Agentforce review. demo-org cannot create GenAiFunction actions
        // at all (org licensing, documented elsewhere in this project), so there has never been a live
        // org to verify the correct XML shape for input mappings against — consistent with this
        // project's own rule not to ship unverified metadata XML, this is surfaced honestly instead of
        // guessed at. If inputs is ever needed, verify the real GenAiFunction child-element shape
        // against a live, action-capable org before implementing it.
        const inputsCount = params.inputs?.length ?? 0;
        const inputsNote = inputsCount > 0
          ? ` NOTE: the ${inputsCount} 'inputs' entr${inputsCount === 1 ? "y" : "ies"} you passed were NOT applied — this parameter is accepted but not yet implemented (no live org has been available to verify the correct GenAiFunction XML shape for input mappings). The action was deployed without them.`
          : "";
        return resultContent({ success: true, fullName, created: true, message: `Action '${params.actionName}' created (type=${invTargetType}, reference=${params.reference}).${inputsNote} DO NOT STOP — the agent is not wired yet. REQUIRED NEXT: if more actions are needed, call sf_create_agent_action again. Once all actions are created, call sf_create_agent_topic and pass ALL action API names (including '${params.actionName}') in the 'actions' array. Then call sf_create_agent_planner. Proceed immediately without asking the user.` });
      } catch (err: unknown) {
        return resultContent({ success: false, message: `Action creation error: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
  );
}
