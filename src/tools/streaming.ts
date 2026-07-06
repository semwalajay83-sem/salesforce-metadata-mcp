import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CreatePushTopicSchema,
  ConfigureChangeDataCaptureSchema,
  CreatePlatformCachePartitionSchema,
} from "../schemas/index.js";
import {
  getAuth,
  createPushTopic,
  configureChangeDataCapture,
  createPlatformCachePartition,
} from "../services/salesforce.js";
import { resultContent } from "./utils.js";

export function registerStreamingTools(server: McpServer): void {

  server.registerTool(
    "sf_create_push_topic",
    {
      title: "Create Streaming API PushTopic",
      description: `Creates a Streaming API PushTopic for real-time record change notifications via the SObject API. Clients subscribe to /topic/TopicName using the CometD protocol. Specify the SOQL query that filters which records trigger events, and configure which operations (create, update, delete, undelete) and fields trigger notifications.`,
      inputSchema: CreatePushTopicSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createPushTopic(auth, params);
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_configure_change_data_capture",
    {
      title: "Configure Change Data Capture",
      description: `Enables Change Data Capture (CDC) for the specified Salesforce objects via the Metadata API. CDC publishes change events to the /data/ChangeEvents channel when records are created, updated, deleted, or undeleted. Provide an array of object API names to enable CDC on. Standard and custom objects are supported.`,
      inputSchema: ConfigureChangeDataCaptureSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await configureChangeDataCapture(auth, params);
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_platform_cache_partition",
    {
      title: "Create Platform Cache Partition",
      description: `Creates a Platform Cache partition in the Salesforce org via the Metadata API. Platform Cache improves app performance by storing data server-side close to Apex code. Allocate capacity for session cache (per-user, per-session) and org cache (shared across all users). Optionally mark as the default partition.`,
      inputSchema: CreatePlatformCachePartitionSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createPlatformCachePartition(auth, params);
      return resultContent(result);
    }
  );
}
