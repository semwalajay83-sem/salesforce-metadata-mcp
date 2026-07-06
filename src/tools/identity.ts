import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CreateAuthProviderSchema,
  CreateSamlSsoConfigSchema,
  CreateConnectedAppOAuthPolicySchema,
} from "../schemas/index.js";
import {
  getAuth,
  createAuthProvider,
  createSamlSsoConfig,
  createConnectedAppOAuthPolicy,
} from "../services/salesforce.js";
import { resultContent } from "./utils.js";

export function registerIdentityTools(server: McpServer): void {

  server.registerTool(
    "sf_create_auth_provider",
    {
      title: "Create Auth Provider",
      description: `Creates an Auth Provider in Salesforce for SSO or social login via the Metadata API. Supports OpenID Connect, Facebook, Google, GitHub, Salesforce, and Custom providers. Provide the consumer key and secret from the external identity provider. Optionally specify an Apex registration handler class for custom user provisioning logic.`,
      inputSchema: CreateAuthProviderSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createAuthProvider(auth, params);
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_saml_sso_config",
    {
      title: "Create SAML SSO Configuration",
      description: `Creates a SAML Single Sign-On (SSO) configuration in Salesforce via the Metadata API. Provide the identity provider issuer URL, base64-encoded IdP certificate, login URL, and user identity mapping settings. Supports username, federation ID, and user ID identity types. Used to enable SAML 2.0 federation with external identity providers.`,
      inputSchema: CreateSamlSsoConfigSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createSamlSsoConfig(auth, params);
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_connected_app_oauth_policy",
    {
      title: "Update Connected App OAuth Policies",
      description: `Updates the OAuth policies on an existing Connected App in Salesforce via the Metadata API. Configure the refresh token policy (infinite, specific duration, or expire on password change), single logout URL, session timeout, and IP relaxation settings. Use this to tighten or adjust security policies on deployed Connected Apps.`,
      inputSchema: CreateConnectedAppOAuthPolicySchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createConnectedAppOAuthPolicy(auth, params);
      return resultContent(result);
    }
  );
}
