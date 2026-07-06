import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CreateLetterheadSimpleSchema,
  CreateNotificationTypeSchema,
} from "../schemas/index.js";
import {
  getAuth,
  createLetterheadSimple,
  createNotificationType,
} from "../services/salesforce.js";
import { resultContent } from "./utils.js";

export function registerCommsTools(server: McpServer): void {
  server.registerTool("sf_create_letterhead", {
    title: "Create Email Letterhead",
    description: `Creates a Letterhead that provides a consistent visual wrapper for HTML email templates. Letterheads define header, body, and footer colors and can be referenced by email templates to ensure brand consistency across automated emails.

fullName: letterhead API name
name: display name
backgroundColor: page background color hex, e.g. '#FFFFFF'
bodyColor: body area background color hex
headerColor: header section background color hex
description: optional description`,
    inputSchema: CreateLetterheadSimpleSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await createLetterheadSimple(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_create_notification_type", {
    title: "Create Custom Notification Type",
    description: `Creates a Custom Notification Type for sending in-app and mobile push notifications. Custom notification types can be triggered from Flows, Apex, or Process Builder. Users receive notifications in the Salesforce Bell icon (desktop) and on the Salesforce mobile app.

fullName: notification type API name
masterLabel: display label
customNotifTypeName: developer name for the notification type
description: optional description`,
    inputSchema: CreateNotificationTypeSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await createNotificationType(auth, params);
    return resultContent(result);
  });
}
