import JSZip from "jszip";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CreateAgentSchema, CreateAgentTopicSchema, CreateAgentActionSchema, CreateAgentPlannerSchema } from "../schemas/index.js";
import { getAuth, x, API_VERSION } from "../services/salesforce.js";
import { buildGenericDeployZip, deployZip, pollDeployStatus } from "../services/deployment.js";
import { resultContent } from "./utils.js";

const SF_NS = "http://soap.sforce.com/2006/04/metadata";

async function buildBotDeployZip(params: {
  agentName: string; label: string; description?: string;
  type?: string; company?: string; tone?: string; role?: string; instructions?: string; apiVersion: string;
}): Promise<string> {
  // MDAPI format: BotVersion is embedded as <botVersions> inside the single .bot file
  // Ground truth values retrieved from real org (2026-06-17):
  //   agentType = EinsteinServiceAgent (BotType enum; EinsteinCopilot and Default are both invalid)
  //   type      = InternalCopilot      (GenAiAgentType enum; EinsteinCopilot is invalid)
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
    <entryDialog>Welcome</entryDialog>
    <intentDisambiguationEnabled>false</intentDisambiguationEnabled>
    <intentV3Enabled>false</intentV3Enabled>
    <knowledgeActionEnabled>false</knowledgeActionEnabled>
    <knowledgeFallbackEnabled>false</knowledgeFallbackEnabled>
    ${params.role ? `<role>${x(params.role)}</role>` : ""}
    ${params.instructions ? `<systemPrompt>${x(params.instructions)}</systemPrompt>` : ""}
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
      description: `Creates an Agentforce Agent (Einstein Copilot) shell in Salesforce. THIS IS STEP 1 OF A 5-STEP SEQUENCE — calling this tool alone produces a non-functional agent shell. You MUST continue calling tools in this exact order without stopping: (0) FIRST create the backing flows (sf_create_flow, flowType=AutoLaunchedFlow, status=Active) and/or Apex classes (sf_create_apex_class with @InvocableMethod) for each capability. (1) THIS TOOL — sf_create_agent. (2) sf_create_agent_action — one call per flow/apex. (3) sf_create_agent_topic — group actions into topics; pass all action API names in the 'actions' array. (4) sf_create_agent_planner — wire topics to the agent. DO NOT report completion to the user until sf_create_agent_planner succeeds. Do not ask the user for confirmation between steps — proceed through all steps autonomously.`,
      inputSchema: CreateAgentSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      try {
        const base64Zip = await buildBotDeployZip({
          agentName: params.agentName,
          label: params.label ?? params.agentName,
          description: params.description,
          type: params.type,
          company: params.company,
          tone: params.tone,
          role: params.persona,
          instructions: params.instructions,
          apiVersion: API_VERSION,
        });
        const deployId = await deployZip(auth, base64Zip, { rollbackOnError: true });
        const result = await pollDeployStatus(auth, deployId, 10 * 60 * 1000);
        if (!result.success) return resultContent({ ...result, message: `Agent deployment failed. Common causes: (1) Agentforce/Einstein Copilot is not enabled in this org — enable it in Setup → Agentforce, (2) agentName contains invalid characters — use letters and numbers only, no underscores, (3) Developer Edition orgs may lack Einstein features. Salesforce error: ${result.message ?? JSON.stringify(result)}` });
        return resultContent({ success: true, fullName: params.agentName, created: true, message: `Agent shell '${params.agentName}' created (step 1 of 4 complete). THE AGENT IS NOT FUNCTIONAL YET — do not report success to the user. REQUIRED NEXT ACTIONS (call these tools now, in order, without stopping): [2] sf_create_agent_action — one call per flow or Apex action. [3] sf_create_agent_topic — pass ALL action API names in the 'actions' array. [4] sf_create_agent_planner — final wiring step. Only after sf_create_agent_planner succeeds is the agent usable. Proceed immediately.` });
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
        const topicFunctionsXml = params.topicNames.map((t, i) => `
  <genAiPlannerFunctions>
    <genAiPlugin>${x(t)}</genAiPlugin>
    <sortOrder>${i}</sortOrder>
  </genAiPlannerFunctions>`).join("");
        const plannerXml = `<?xml version="1.0" encoding="UTF-8"?>
<GenAiPlanner xmlns="${SF_NS}">
  <botName>${x(params.agentName)}</botName>
  <developerName>${x(params.agentName)}</developerName>
  <masterLabel>${x(params.label ?? params.agentName)}</masterLabel>${topicFunctionsXml}
</GenAiPlanner>`;
        const base64Zip = await buildGenericDeployZip([], API_VERSION, [{ type: "GenAiPlanner", name: params.agentName, xml: plannerXml }]);
        const deployId = await deployZip(auth, base64Zip, { rollbackOnError: true });
        const result = await pollDeployStatus(auth, deployId, 10 * 60 * 1000);
        if (!result.success) return resultContent({ ...result, message: `Planner deployment failed. Check that: (1) agentName matches an existing Bot/agent in the org, (2) all topicNames exist in the org (created via sf_create_agent_topic). Salesforce error: ${result.message ?? JSON.stringify(result)}` });
        return resultContent({ success: true, fullName: params.agentName, created: true, message: `Agent '${params.agentName}' is now fully wired — topics connected: ${params.topicNames.join(", ")}. The agent can now route user requests to these topics. Activate the agent in Setup → Agentforce to make it live.` });
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
        if (!result.success) return resultContent({ ...result, message: `Action deployment failed. Check that: (1) for Flow type — the flow '${params.reference}' exists and is Active (not Draft), (2) for ApexClass type — the class '${params.reference}' exists and has @InvocableMethod annotation, (3) actionName contains only letters/numbers/underscores. Salesforce error: ${result.message ?? JSON.stringify(result)}` });
        return resultContent({ success: true, fullName, created: true, message: `Action '${params.actionName}' created (type=${invTargetType}, reference=${params.reference}). DO NOT STOP — the agent is not wired yet. REQUIRED NEXT: if more actions are needed, call sf_create_agent_action again. Once all actions are created, call sf_create_agent_topic and pass ALL action API names (including '${params.actionName}') in the 'actions' array. Then call sf_create_agent_planner. Proceed immediately without asking the user.` });
      } catch (err: unknown) {
        return resultContent({ success: false, message: `Action creation error: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
  );
}
