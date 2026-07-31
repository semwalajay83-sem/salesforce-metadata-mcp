import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CreateConnectedAppSchema,
  CreateExternalClientAppSchema,
  CreateExternalDataSourceSchema,
  CreateExternalObjectSchema,
  CreateRemoteSiteSettingSchema,
  CreateCspSettingSchema,
} from "../schemas/index.js";
import {
  getAuth,
  createConnectedApp,
  createExternalClientApp,
  createExternalDataSource,
  createExternalObject,
  createRemoteSiteSetting,
  createCspSetting,
} from "../services/salesforce.js";
import { resultContent } from "./utils.js";

export function registerIntegrationTools(server: McpServer): void {

  server.registerTool(
    "sf_create_connected_app",
    {
      title: "Create Connected App (OAuth)",
      description: `Creates a Connected App in Salesforce to enable OAuth authentication for external applications. Connected Apps are required for any external system that wants to connect to Salesforce via OAuth 2.0. Specify callback URLs for the OAuth flow, OAuth scopes (api, web, full, offline_access, etc.), and contact email. Used for web apps, mobile apps, desktop apps, or server-to-server integrations.`,
      inputSchema: CreateConnectedAppSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createConnectedApp(auth, {
        fullName: params.fullName,
        label: params.label,
        description: params.description,
        contactEmail: params.contactEmail,
        callbackUrls: params.callbackUrls,
        scopes: params.scopes,
        consumerKey: params.consumerKey,
        startUrl: params.startUrl,
        accessTokenValidity: params.accessTokenValidity,
        refreshTokenValidity: params.refreshTokenValidity,
        enableClientCredentialsFlow: params.enableClientCredentialsFlow,
      });
      if (result.success) {
        return resultContent({ ...result, message: `${result.message ?? ""} Consumer Key/Secret and the Client Credentials Flow 'Run As' user can ONLY be viewed/set in Setup → App Manager → ${params.fullName} — no API exposes the Consumer Secret or the Run As user picker, by Salesforce design. Consider sf_create_external_client_app instead: its Run As user IS settable via this API.`.trim() });
      }
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_external_client_app",
    {
      title: "Create External Client App (OAuth) — recommended over Connected App",
      description: `Creates an External Client App (ECA), Salesforce's newer replacement for Connected Apps, for OAuth authentication and server-to-server integrations. Prefer this over sf_create_connected_app: on ECAs, Client Credentials Flow — including which user it runs as — is fully configurable via this tool (enableClientCredentialsFlow + clientCredentialsFlowUser), whereas on classic Connected Apps that same setting can only be picked in Setup UI. Deploys all 3 underlying metadata records (ExternalClientApplication, ExtlClntAppOauthSettings, ExtlClntAppOauthConfigurablePolicies) in one call. Use 'Chatbot' and/or 'SFApiPlatform' scopes for any app that needs to call the Salesforce Agent API (e.g. testing an Agentforce agent's conversation flow) or a bot's Messaging API. NOTE: the Consumer Key/Secret this app needs to actually mint a token can still only be viewed once in Setup → External Client Apps → [name] → Settings → OAuth Settings — no Salesforce API exposes it, for either app type.`,
      inputSchema: CreateExternalClientAppSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createExternalClientApp(auth, {
        fullName: params.fullName,
        label: params.label,
        description: params.description,
        contactEmail: params.contactEmail,
        scopes: params.scopes,
        enableClientCredentialsFlow: params.enableClientCredentialsFlow,
        clientCredentialsFlowUser: params.clientCredentialsFlowUser,
        permittedUsersPolicyType: params.permittedUsersPolicyType,
        ipRelaxationPolicyType: params.ipRelaxationPolicyType,
        refreshTokenPolicyType: params.refreshTokenPolicyType,
      });
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_external_data_source",
    {
      title: "Create External Data Source",
      description: `Creates an External Data Source for Salesforce Connect, enabling read-write access to data stored outside Salesforce without importing it. Supports OData 2.0/4.0 for standard REST services, SimpleURL for basic access, Apex for custom adapters. The external data then appears as External Objects (__x) in Salesforce.`,
      inputSchema: CreateExternalDataSourceSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createExternalDataSource(auth, {
        fullName: params.fullName,
        label: params.label,
        type: params.type,
        endpoint: params.endpoint,
        principalType: params.principalType,
        protocol: params.protocol,
        username: params.username,
        description: params.description,
      });
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_external_object",
    {
      title: "Create External Object",
      description: `Creates an External Object (ending in __x) linked to an External Data Source. External Objects look like regular Salesforce objects but their data lives in an external system. They support lookups from standard/custom objects, appear in related lists, and can be used in reports. Requires an existing External Data Source.`,
      inputSchema: CreateExternalObjectSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createExternalObject(auth, {
        fullName: params.fullName,
        label: params.label,
        pluralLabel: params.pluralLabel,
        externalDataSource: params.externalDataSource,
        externalName: params.externalName,
        description: params.description,
        fields: params.fields,
      });
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_remote_site_setting",
    {
      title: "Create Remote Site Setting",
      description: `Creates a Remote Site Setting to allow an external URL for Apex callouts. Salesforce blocks outbound HTTP calls by default — adding a Remote Site Setting allows Apex code to call that URL. Required for any external API callout from Apex or Flows. Use with sf_create_named_credential for authenticated callouts.`,
      inputSchema: CreateRemoteSiteSettingSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createRemoteSiteSetting(auth, {
        fullName: params.fullName,
        name: params.name,
        url: params.url,
        description: params.description,
        isActive: params.isActive,
        disableProtocolSecurity: params.disableProtocolSecurity,
      });
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_csp_setting",
    {
      title: "Create Content Security Policy (CSP) Trusted Site",
      description: `Creates a Content Security Policy trusted site, allowing LWC components and Visualforce pages to load resources from external URLs. CSP settings are needed when your LWC uses external JavaScript libraries, fonts, images, or APIs. Specify which directives (connect-src, script-src, style-src, img-src, etc.) the URL is trusted for.`,
      inputSchema: CreateCspSettingSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createCspSetting(auth, {
        endpointUrl: params.endpointUrl,
        cspDirectives: params.cspDirectives,
        description: params.description,
        isActive: params.isActive,
      });
      return resultContent(result);
    }
  );
}
