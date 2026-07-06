import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CreateServiceChannelSchema, CreateRoutingConfigurationSchema, CreateQueueRoutingConfigSchema,
  CreatePresenceConfigurationSchema, CreatePresenceStatusSchema, AssignPresenceStatusSchema,
  CreateSkillSchema, AssignSkillToAgentSchema, CreateServiceTerritorySchema, CreateWorkTypeSchema,
  CreateMessagingChannelSchema, CreateChatButtonSchema, CreateEmbeddedServiceSchema, CreateBotRoutingSchema,
} from "../schemas/index.js";
import {
  getAuth,
  createServiceChannel, createRoutingConfiguration, createQueueRoutingConfig,
  createPresenceConfiguration, createPresenceStatus, assignPresenceStatus,
  createSkill, assignSkillToAgent, createServiceTerritory, createWorkType,
  createMessagingChannel, createChatButton, createEmbeddedService, createBotRouting,
} from "../services/salesforce.js";
import { resultContent } from "./utils.js";

export function registerOmniChannelTools(server: McpServer): void {
  // ─── SERVICE CHANNELS & ROUTING ───────────────────────────────────────────
  server.registerTool("sf_create_service_channel", {
    title: "Create OmniChannel Service Channel",
    description: `Creates an OmniChannel Service Channel that connects work items from a Salesforce object to the OmniChannel routing engine.

channelType options: Case, Chat, Messaging, Voice, Email, SocialPost, Custom

relatedObjectApiName: the Salesforce object this channel routes (e.g. "Case", "LiveChatTranscript", "MessagingSession"). Required for Custom type.

capacity: maximum number of simultaneous work items an agent can handle on this channel (default 1).

Service Channels are referenced by Routing Configurations and Presence Configurations.`,
    inputSchema: CreateServiceChannelSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await createServiceChannel(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_create_routing_configuration", {
    title: "Create OmniChannel Routing Configuration",
    description: `Creates a Routing Configuration that defines how work items are assigned to agents.

routingModel options:
- LeastActive: routes to the agent with the fewest active work items
- MostAvailable: routes to the agent with the most available capacity
- ExternalRouting: custom routing via Apex or external system

capacity: agent capacity consumed per work item (1–100)
priority: routing priority (lower number = higher priority, range 1–10)
unitType: Percentage or Throughput (how capacity is measured)
pushTimeout: seconds before a declined/unanswered item is re-queued (optional)

After creating, link it to a queue with sf_create_queue_routing_config.`,
    inputSchema: CreateRoutingConfigurationSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await createRoutingConfiguration(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_create_queue_routing_config", {
    title: "Link Routing Configuration to Queue",
    description: `Associates a Routing Configuration with an existing Queue, enabling OmniChannel routing for that queue.

After creating a Routing Configuration (sf_create_routing_configuration), use this tool to link it to the Queue that holds the work items. Work items assigned to the queue will then be routed to agents using the specified routing model.

queueDeveloperName: the API name of the Queue (DeveloperName, not label)
routingConfigName: the API name of the Routing Configuration to link`,
    inputSchema: CreateQueueRoutingConfigSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await createQueueRoutingConfig(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_create_presence_configuration", {
    title: "Create OmniChannel Presence Configuration",
    description: `Creates a Presence Configuration (PresenceUserConfig) that controls which Service Channels agents can handle and their total work capacity.

capacity: total capacity units available to agents with this configuration
serviceChannels: list of Service Channel API names the agents can work on
allowAgentsToChangeStatus: whether agents can manually change their presence status

Assign this configuration to agents via their Profile or Permission Set.`,
    inputSchema: CreatePresenceConfigurationSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await createPresenceConfiguration(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_create_presence_status", {
    title: "Create OmniChannel Presence Status",
    description: `Creates a Presence Status that agents can set to indicate their availability.

statusType:
- Online: agent is available for all assigned channels
- Busy: agent is limited to specific channels
- Offline: agent receives no work items

serviceChannels: for Busy status, list which channels remain active.

After creating, assign the status to profiles/permission sets with sf_assign_presence_status.`,
    inputSchema: CreatePresenceStatusSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await createPresenceStatus(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_assign_presence_status", {
    title: "Assign Presence Status to Profiles/Permission Sets",
    description: `Grants access to a Presence Status for the specified Profiles and/or Permission Sets. Agents can only select presence statuses that are assigned to their profile or permission set.

profiles: list of Profile names (e.g. ["Standard User", "Service Agent"])
permissionSets: list of Permission Set API names

Either profiles or permissionSets must be provided (or both).`,
    inputSchema: AssignPresenceStatusSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await assignPresenceStatus(auth, params);
    return resultContent(result);
  });

  // ─── SKILLS & FIELD SERVICE ───────────────────────────────────────────────
  server.registerTool("sf_create_skill", {
    title: "Create OmniChannel / Field Service Skill",
    description: `Creates a Skill that can be assigned to service agents. Skills are used for:
- OmniChannel skill-based routing (route work to agents with required skills)
- Field Service Lightning (assign skills to resources, skills to work types)

After creating a skill, assign it to agents with sf_assign_skill_to_agent.`,
    inputSchema: CreateSkillSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await createSkill(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_assign_skill_to_agent", {
    title: "Assign Skill to Service Agent",
    description: `Assigns a Skill to a Salesforce user (service agent) with a skill level rating. Creates a ServiceResource for the user if one does not already exist, then creates a ServiceResourceSkill record.

skillName: the API name (DeveloperName) of the skill to assign
username: the Salesforce username (e.g. agent@example.com) or user ID
skillLevel: proficiency level from 0 to 10 (default 5)

ServiceResource is the Field Service / OmniChannel representation of a user as a workable resource.`,
    inputSchema: AssignSkillToAgentSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await assignSkillToAgent(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_create_service_territory", {
    title: "Create Field Service Service Territory",
    description: `Creates a Service Territory for Field Service Lightning. Territories define the geographic areas or organizational divisions where field service resources operate.

isActive: set true to make the territory immediately available for scheduling
operatingHoursName: API name of an existing OperatingHours record to set business hours
Address fields (street, city, state, country, postalCode): optional location for the territory center`,
    inputSchema: CreateServiceTerritorySchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await createServiceTerritory(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_create_work_type", {
    title: "Create Field Service Work Type",
    description: `Creates a Work Type that defines a category of field service job. Work Types set default durations, block times, and skill requirements for work orders.

estimatedDuration: expected time to complete the work
durationType: Minutes, Hours, or Days
blockTimeBeforeWork: travel/prep time before the appointment
blockTimeAfterWork: cleanup/travel time after the appointment
skillRequirements: array of { skillName, skillLevel } — skills required on the resource to perform this work type`,
    inputSchema: CreateWorkTypeSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await createWorkType(auth, params);
    return resultContent(result);
  });

  // ─── MESSAGING, CHAT & VOICE ──────────────────────────────────────────────
  server.registerTool("sf_create_messaging_channel", {
    title: "Create Messaging Channel",
    description: `Creates a Messaging Channel for Salesforce digital engagement (SMS, WhatsApp, Facebook Messenger, Apple Messages for Business, etc.).

channelType options: SMS, WhatsApp, Facebook, AppleBusinessChat, Line, GoogleBusinessMessages, EinsteinBotChannel, WebChat

phoneNumber: E.164 format phone number for SMS/WhatsApp channels (e.g. +15551234567)
pageId: Facebook Page ID or equivalent external platform identifier

routingType: Queue (route to a queue) or Bot (route to an Einstein Bot first)
queueName: required when routingType=Queue
botName: required when routingType=Bot (bot handles initial messages)

After creating, configure the channel with sf_create_embedded_service to add it to a site.`,
    inputSchema: CreateMessagingChannelSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await createMessagingChannel(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_create_chat_button", {
    title: "Create Live Agent Chat Button",
    description: `Creates a Live Chat button (LiveChatButton) that can be embedded on websites to start chat sessions with agents.

routingType: Choice (skills-based) or Queue (queue-based routing)
queueName: the Queue to route chats to (for Queue routing)
botName: an Einstein Bot to handle chats initially (optional)
windowLanguage: display language for the chat window (e.g. "en_US", "fr", "de")
inviteRenderer: name of a custom Visualforce page for chat invitations
customAgentName: agent display name shown to website visitors
optionsHasTimeoutAlert: show alert if no agent available within timeout period

After creating, embed the chat button on a site with sf_create_embedded_service.`,
    inputSchema: CreateChatButtonSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await createChatButton(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_create_embedded_service", {
    title: "Create Embedded Service Deployment",
    description: `Creates an Embedded Service deployment (EmbeddedServiceConfig) that bundles a chat button or messaging channel into a web snippet for embedding on websites or Experience Cloud sites.

channelType: Chat (uses a LiveChatButton) or Messaging (uses a MessagingChannel)
chatButtonName: required for Chat type — the LiveChatButton API name
messagingChannelName: required for Messaging type — the MessagingChannel API name
site: the Experience Cloud site or Salesforce Site API name to associate with

Branding:
- primaryColor: main brand color (hex, e.g. "#0070D2")
- secondaryColor: secondary/header color
- fontName: web font name (e.g. "Salesforce Sans")

After creation, get the deployment code snippet from Setup → Embedded Service Deployments.`,
    inputSchema: CreateEmbeddedServiceSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await createEmbeddedService(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_create_bot_routing", {
    title: "Configure Bot Escalation Routing",
    description: `Configures an Einstein Bot to transfer conversations to a human agent queue when escalation conditions are met. Updates the BotVersion with a Transfer dialog.

botName: the Bot API name (DeveloperName)
transferToQueueName: the Queue API name to transfer escalated conversations to
transferMessage: message shown to the customer during transfer (default: "Connecting you to an agent...")
escalationConditions: array of { trigger, action } pairs. Triggers: agentRequested, noResponse, fallback. Actions: TransferToQueue.

This tool finds the latest BotVersion for the specified bot and adds the transfer dialog. The bot must already exist (created via Setup or sf_create_agent).`,
    inputSchema: CreateBotRoutingSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await createBotRouting(auth, params);
    return resultContent(result);
  });
}
