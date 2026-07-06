import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CreateEinsteinPredictionSchema, CreateNextBestActionSchema, CreateEinsteinBotSchema,
} from "../schemas/index.js";
import { getAuth, createEinsteinPrediction, createNextBestAction, createEinsteinBot } from "../services/salesforce.js";
import { resultContent } from "./utils.js";

export function registerEinsteinTools(server: McpServer): void {
  server.registerTool("sf_create_einstein_prediction", {
    title: "Create Einstein Prediction (ML Prediction Definition)",
    description: `Creates an Einstein Prediction Builder prediction definition (MLPredictionDefinition metadata type). Predictions analyze historical Salesforce data to score or classify records automatically.

predictionType:
- BinaryClassification: predict a yes/no outcome (e.g. Will this opportunity close? Is this lead likely to convert?)
- Regression: predict a numeric value (e.g. Expected revenue, likelihood score)

targetField: the field the prediction is based on (e.g. 'IsWon' for BinaryClassification on Opportunity)
pushbackField: an existing custom field to write the prediction score to automatically

IMPORTANT: Einstein Prediction Builder requires an Einstein Analytics license or the Einstein Platform add-on. If the org lacks this license, the metadata deployment will succeed but the prediction cannot be trained or activated. This tool creates the definition — training happens in Setup → Einstein → Prediction Builder.

The prediction is created in Draft status. Activate it from Setup after training is complete.`,
    inputSchema: CreateEinsteinPredictionSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await createEinsteinPrediction(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_create_next_best_action", {
    title: "Create Next Best Action Strategy",
    description: `Creates a Next Best Action (NBA) recommendation strategy (RecommendationStrategy metadata type). NBA strategies surface contextual recommendations to agents and customers on record pages, communities, and chatbots.

A strategy defines:
- contextObjectApiName: the record type that provides context (e.g. 'Account', 'Case', 'Opportunity')
- recommendations: a list of actions the agent can offer, each with Accept/Decline buttons and an optional Flow to execute on acceptance

NBA strategies can be displayed via:
- Einstein Next Best Action component on a Lightning Record Page
- OmniScripts and FlexCards
- Service Console

After creating, add the "Einstein Next Best Action" Lightning component to a record page and configure it to use this strategy.`,
    inputSchema: CreateNextBestActionSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await createNextBestAction(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_create_einstein_bot", {
    title: "Create Einstein Bot (Classic)",
    description: `Creates a classic Einstein Bot (Bot + BotVersion metadata types) with one or more conversation dialogs. Classic Einstein Bots handle chat and messaging channels via rule-based and ML-powered conversation flows.

Note: For AI-first agents using large language models, use sf_create_agent (Agentforce/Einstein Service Agent) instead. Classic Einstein Bots are best suited for:
- Structured FAQ automation
- Simple data collection workflows
- Channels that don't support Agentforce (SMS, WhatsApp via classic routing)

Each dialog defines:
- name/label: the dialog identifier
- utterances: training phrases that trigger this dialog
- messages: bot responses shown to the user
- type: Main (user-facing), System (internal), Rule (condition-based)

The bot is created with an ML domain for intent classification. After creation:
1. Train the bot in Setup → Einstein Bots → {BotName} → Train
2. Activate the bot
3. Connect it to a messaging channel or chat button`,
    inputSchema: CreateEinsteinBotSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await createEinsteinBot(auth, params);
    return resultContent(result);
  });
}
