import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolsetRegistry } from "../toolsets.js";
import { registerMetadataTools } from "./metadata.js";
import { registerObjectTools } from "./objects.js";
import { registerAutomationTools } from "./automation.js";
import { registerSecurityTools } from "./security.js";
import { registerUiTools } from "./ui.js";
import { registerApexTools } from "./apex.js";
import { registerLwcTools } from "./lwc.js";
import { registerExperienceTools } from "./experience.js";
import { registerAgentforceTools } from "./agentforce.js";
import { registerDeploymentTools } from "./deployment.js";
import { registerMcpTools } from "./mcp.js";
import { registerIntegrationTools } from "./integrations.js";
import { registerReportTools } from "./reports.js";
import { registerDataTools } from "./data.js";
import { registerOmniStudioTools } from "./omnistudio.js";
import { registerOmniChannelTools } from "./omnichannel.js";
import { registerAuditTools } from "./audit.js";
import { registerEinsteinTools } from "./einstein.js";
import { registerAdminTools } from "./admin.js";
import { registerMonitoringTools } from "./monitoring.js";
import { registerCommsTools } from "./comms.js";
import { registerDevOpsTools } from "./devops.js";
import { registerCpqTools } from "./cpq.js";
import { registerVisualforceTools } from "./visualforce.js";
import { registerActionTools } from "./actions.js";
import { registerPageTools } from "./pages.js";
import { registerKnowledgeTools } from "./knowledge.js";
import { registerIdentityTools } from "./identity.js";
import { registerSandboxTools } from "./sandbox.js";
import { registerStreamingTools } from "./streaming.js";
import { registerAuraTools } from "./aura.js";
import { registerFlowManagementTools } from "./flows.js";
import { registerI18nTools } from "./i18n.js";

export function registerTools(server: McpServer): ToolsetRegistry {
  const registry = new ToolsetRegistry();

  // Group name -> register function. The names here are the toolset names users and models see,
  // and must match the keys in TOOLSET_INFO. Each function is handed a capturing proxy rather than
  // the raw server, so every tool it registers is attributed to its group without the 33 modules
  // needing to know anything about toolsets.
  const groups: [string, (s: McpServer) => void][] = [
    ["metadata", registerMetadataTools],
    ["objects", registerObjectTools],
    ["automation", registerAutomationTools],
    ["security", registerSecurityTools],
    ["ui", registerUiTools],
    ["apex", registerApexTools],
    ["lwc", registerLwcTools],
    ["experience", registerExperienceTools],
    ["agentforce", registerAgentforceTools],
    ["deployment", registerDeploymentTools],
    ["mcp", registerMcpTools],
    ["integrations", registerIntegrationTools],
    ["reports", registerReportTools],
    ["data", registerDataTools],
    ["omnistudio", registerOmniStudioTools],
    ["omnichannel", registerOmniChannelTools],
    ["audit", registerAuditTools],
    ["einstein", registerEinsteinTools],
    ["admin", registerAdminTools],
    ["monitoring", registerMonitoringTools],
    ["comms", registerCommsTools],
    ["devops", registerDevOpsTools],
    ["cpq", registerCpqTools],
    ["visualforce", registerVisualforceTools],
    ["actions", registerActionTools],
    ["pages", registerPageTools],
    ["knowledge", registerKnowledgeTools],
    ["identity", registerIdentityTools],
    ["sandbox", registerSandboxTools],
    ["streaming", registerStreamingTools],
    ["aura", registerAuraTools],
    ["flows", registerFlowManagementTools],
    ["i18n", registerI18nTools],
  ];

  for (const [name, register] of groups) {
    register(registry.capture(server, name));
  }

  // Reassign the handful of tools whose module is not the toolset they belong in.
  registry.applyOverrides();

  return registry;
}
