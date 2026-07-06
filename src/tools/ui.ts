import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CreateLightningAppSchema,
  CreateTabSchema,
  CreateCompactLayoutSchema,
  CreateListViewSchema,
  CreateEmailTemplateSchema,
  CreateStaticResourceSchema,
  CreateCustomNotificationTypeSchema,
  CreateReportTypeSchema,
  CreateDashboardSchema,
} from "../schemas/index.js";
import {
  getAuth,
  createLightningApp,
  createTab,
  createCompactLayout,
  createListView,
  createEmailTemplate,
  createCustomNotificationType,
  createReportType,
} from "../services/salesforce.js";
import {
  buildStaticResourceZip,
  deployZip,
  pollDeployStatus,
} from "../services/deployment.js";
import { API_VERSION } from "../services/salesforce.js";
import { resultContent } from "./utils.js";

export function registerUiTools(server: McpServer): void {

  server.registerTool(
    "sf_create_lightning_app",
    {
      title: "Create Lightning App",
      description: `Creates a Lightning App in Salesforce — a branded navigation container with a custom navigation bar, utility bar, and logo. Choose between Standard (tabs) and Console (split view) navigation. Specify navItems to populate the navigation bar with objects, home, reports, etc. Use when a user wants a custom app experience for a specific team or use case.`,
      inputSchema: CreateLightningAppSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createLightningApp(auth, {
        fullName: params.fullName,
        label: params.label,
        description: params.description,
        navType: params.navType,
        uiType: params.uiType,
        setupExperience: params.setupExperience,
        isNavAutoTempTabsDisabled: params.isNavAutoTempTabsDisabled,
        isNavPersonalizationDisabled: params.isNavPersonalizationDisabled,
        navItems: params.navItems,
        utilityItems: params.utilityItems,
      });
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_tab",
    {
      title: "Create Custom Tab",
      description: `Creates a Custom Tab for a custom object so it appears in the navigation bar and App Launcher. Tabs are required to make custom objects accessible from the UI. Specify the object API name and choose a motif/icon from Salesforce's icon library (e.g., 'Custom64: Coin').`,
      inputSchema: CreateTabSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createTab(auth, {
        fullName: params.fullName,
        label: params.label,
        motif: params.motif,
        sobjectName: params.sobjectName,
        customObject: params.customObject,
        url: params.url,
        page: params.page,
        description: params.description,
      });
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_compact_layout",
    {
      title: "Create Compact Layout",
      description: `Creates a Compact Layout for a Salesforce object. Compact Layouts define which fields appear in the highlights panel at the top of a record page (up to 10 fields), in Salesforce Mobile, and in related list cards. Use when you want to surface the most important fields at a glance.`,
      inputSchema: CreateCompactLayoutSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createCompactLayout(auth, {
        objectName: params.objectName,
        fullName: params.fullName,
        label: params.label,
        fields: params.fields,
      });
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_list_view",
    {
      title: "Create List View",
      description: `Creates a List View for any Salesforce object. List Views are saved filters that display a subset of records with specific columns, filters, and sorting. Use to create shared views like 'My Open Cases', 'High Priority Leads', or 'Deals Closing This Month' that appear in the object's list view selector.`,
      inputSchema: CreateListViewSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createListView(auth, {
        objectName: params.objectName,
        fullName: params.fullName,
        label: params.label,
        columns: params.columns,
        filters: params.filters,
        booleanFilter: params.booleanFilter,
        filterScope: params.filterScope,
        sharedTo: params.sharedTo,
      });
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_email_template",
    {
      title: "Create Email Template",
      description: `Creates an HTML or text email template that can be used in Workflow Email Alerts, Approval Processes, or sent manually. Templates support merge fields like {!Account.Name} for personalization. Specify a folder path (e.g., 'unfiled$public/MyTemplate') or 'MyFolder/MyTemplate'. Use relatedEntityType to enable object-specific merge fields.`,
      inputSchema: CreateEmailTemplateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createEmailTemplate(auth, {
        fullName: params.fullName,
        name: params.name,
        label: params.label,
        description: params.description,
        subject: params.subject,
        htmlValue: params.htmlValue,
        body: params.body,
        type: params.type,
        relatedEntityType: params.relatedEntityType,
        encoding: params.encoding,
        available: params.available,
        replyTo: params.replyTo,
        senderName: params.senderName,
      });
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_static_resource",
    {
      title: "Create Static Resource",
      description: `Creates a Static Resource from text/JSON/JS/CSS content. Static Resources are files stored in Salesforce and served via a CDN URL — ideal for JavaScript libraries, CSS stylesheets, JSON configuration, or any other file that needs to be served from Salesforce. Content is provided as a string and deployed via the Metadata API.`,
      inputSchema: CreateStaticResourceSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      try {
        const base64Zip = await buildStaticResourceZip(
          params.fullName, params.content, params.contentType, API_VERSION
        );
        const deployId = await deployZip(auth, base64Zip);
        const result = await pollDeployStatus(auth, deployId, 3 * 60 * 1000);
        if (result.success) {
          return resultContent({ success: true, message: `Static resource '${params.fullName}' deployed successfully.`, fullName: params.fullName, created: true });
        }
        return resultContent(result);
      } catch (err: unknown) {
        return resultContent({ success: false, message: err instanceof Error ? err.message : String(err) });
      }
    }
  );

  server.registerTool(
    "sf_create_custom_notification_type",
    {
      title: "Create Custom Notification Type",
      description: `Creates a Custom Notification Type that can be sent from Flows, Apex, or Process Builder using the Send Custom Notification action. Custom Notifications appear in Salesforce notification bell (and optionally mobile push). Use to create in-app alerts for important business events.`,
      inputSchema: CreateCustomNotificationTypeSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createCustomNotificationType(auth, {
        fullName: params.fullName,
        customNotifTypeName: params.customNotifTypeName,
        description: params.description,
        desktop: params.desktop,
        mobile: params.mobile,
      });
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_report_type",
    {
      title: "Create Custom Report Type",
      description: `Creates a Custom Report Type that defines what objects and fields are available when building reports. A report type specifies a primary object and optionally related objects (joined via relationships). Use when the standard report types don't include the data you need, or when you want to create a specialized reporting structure.`,
      inputSchema: CreateReportTypeSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createReportType(auth, {
        fullName: params.fullName,
        label: params.label,
        description: params.description,
        baseObject: params.baseObject,
        category: params.category,
        deployed: params.deployed,
        relationships: params.relationships,
      });
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_dashboard",
    {
      title: "Create Dashboard",
      description: `Creates a Salesforce Dashboard with components (charts, metrics, tables, gauges) powered by reports. Dashboards provide visual summaries of key business data. Specify the folder path as 'FolderName/DashboardName' and add components linked to existing reports. Use when a team needs a visual summary of their metrics.`,
      inputSchema: CreateDashboardSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      // Build dashboard XML inline
      const componentsXml = (params.components ?? []).map((c) => `
        <met:components>
          <met:type>${c.type}</met:type>
          ${c.reportApiName ? `<met:report>${c.reportApiName}</met:report>` : ""}
          ${c.header ? `<met:header>${c.header}</met:header>` : ""}
          ${c.footer ? `<met:footer>${c.footer}</met:footer>` : ""}
          ${c.chartType ? `<met:chartAxisRange>Auto</met:chartAxisRange>` : ""}
          <met:columnSpan>${c.columnSpan}</met:columnSpan>
          <met:rowSpan>${c.rowSpan}</met:rowSpan>
        </met:components>`).join("\n");
      const xml = `<met:metadata xsi:type="met:Dashboard" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <met:fullName>${params.fullName}</met:fullName>
        <met:title>${params.title}</met:title>
        ${params.description ? `<met:description>${params.description}</met:description>` : ""}
        ${params.runningUser ? `<met:runningUser>${params.runningUser}</met:runningUser>` : ""}
        <met:backgroundEndColor>#FFFFFF</met:backgroundEndColor>
        <met:backgroundFadeDirection>Diagonal</met:backgroundFadeDirection>
        <met:backgroundStartColor>#FFFFFF</met:backgroundStartColor>
        <met:textColor>#000000</met:textColor>
        <met:titleColor>#000000</met:titleColor>
        <met:titleSize>12</met:titleSize>
        ${componentsXml}
      </met:metadata>`;
      const { upsertMetadata } = await import("../services/salesforce.js");
      const result = await upsertMetadata(auth, xml);
      return resultContent(result);
    }
  );
}
