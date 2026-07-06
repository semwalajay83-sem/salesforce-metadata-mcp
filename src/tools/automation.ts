import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CreateEmailAlertSchema,
  CreatePlatformEventSchema,
  CreateAssignmentRuleSchema,
  CreateEscalationRuleSchema,
  CreateAutoResponseRuleSchema,
  CreateMatchingRuleSchema,
  CreateDuplicateRuleSchema,
  CreateApexEmailServiceSchema,
  CreateScheduledJobSchema,
  CreateScheduledFlowSchema,
  CreatePlatformEventTriggerSchema,
  CreateWorkflowRuleSchema,
  CreateFieldUpdateSchema,
  CreateWorkflowOutboundMessageSchema,
} from "../schemas/index.js";
import {
  getAuth,
  createEmailAlert,
  createPlatformEvent,
  createAssignmentRule,
  createAutoResponseRule,
  createMatchingRule,
  createDuplicateRule,
  createScheduledFlow,
  createPlatformEventTrigger,
  createWorkflowRule,
  createFieldUpdate,
  createWorkflowOutboundMessage,
  x,
} from "../services/salesforce.js";
import {
  createApexEmailService,
  createScheduledJob,
} from "../services/tooling.js";
import { resultContent } from "./utils.js";

export function registerAutomationTools(server: McpServer): void {

  server.registerTool(
    "sf_create_email_alert",
    {
      title: "Create Workflow Email Alert",
      description: `Creates a Workflow Email Alert action that can be triggered by Flows, Approval Processes, or Workflow Rules. Specify the email template to use and recipients (owner, creator, users, roles, or custom email addresses). Use when you need to send notification emails as part of automation.`,
      inputSchema: CreateEmailAlertSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createEmailAlert(auth, {
        objectName: params.objectName,
        alertName: params.alertName,
        label: params.label,
        description: params.description,
        template: params.template,
        senderType: params.senderType,
        senderAddress: params.senderAddress,
        recipients: params.recipients,
        protected: params.protected,
      });
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_platform_event",
    {
      title: "Create Platform Event",
      description: `Creates a Platform Event object (ending in __e) for event-driven architecture. Platform Events enable real-time publish/subscribe communication between systems. Publishers fire events and subscribers (Flows, Apex triggers, external systems) react to them. PublishAfterCommit waits for DML to commit; PublishImmediately fires right away.`,
      inputSchema: CreatePlatformEventSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createPlatformEvent(auth, {
        fullName: params.fullName,
        label: params.label,
        pluralLabel: params.pluralLabel,
        description: params.description,
        publishBehavior: params.publishBehavior,
        fields: params.fields,
      });
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_assignment_rule",
    {
      title: "Create Lead or Case Assignment Rule",
      description: `Creates an Assignment Rule for Leads or Cases. Assignment rules automatically route new records to the appropriate owner (user or queue) based on matching criteria. Only one rule can be active at a time per object. Rule entries are evaluated top-to-bottom and the first match wins.`,
      inputSchema: CreateAssignmentRuleSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createAssignmentRule(auth, {
        objectName: params.objectName,
        ruleName: params.ruleName,
        label: params.label,
        active: params.active,
        ruleEntries: params.ruleEntries,
      });
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_escalation_rule",
    {
      title: "Create Case Escalation Rule",
      description: `Creates an Escalation Rule for Cases. Escalation rules automatically escalate cases that haven't been closed within a specified time, reassigning them to other users or queues and optionally sending notifications. Based on business hours and a configurable start date (creation time or last modification).`,
      inputSchema: CreateEscalationRuleSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      // Build escalation XML manually
      const entriesXml = params.ruleEntries.map(e => {
        const criteriaXml = (e.criteriaItems ?? []).map((c: { field: string; operation: string; value: string }) => `
          <met:criteriaItems>
            <met:field>${x(c.field)}</met:field>
            <met:operation>${x(c.operation)}</met:operation>
            <met:value>${x(c.value)}</met:value>
          </met:criteriaItems>`).join("\n");
        const actionsXml = e.escalationActions.map((a: { minutesToEscalation: number; assignedTo?: string; assignedToType?: string; notifyTo?: string; template?: string }) => `
          <met:escalationAction>
            <met:minutesToEscalation>${a.minutesToEscalation}</met:minutesToEscalation>
            ${a.assignedTo ? `<met:assignedTo>${a.assignedTo}</met:assignedTo><met:assignedToType>${a.assignedToType ?? "Queue"}</met:assignedToType>` : ""}
            ${a.notifyTo ? `<met:notifyTo>${a.notifyTo}</met:notifyTo>` : ""}
            ${a.template ? `<met:template>${a.template}</met:template>` : ""}
          </met:escalationAction>`).join("\n");
        return `<met:ruleEntry>
          ${criteriaXml}
          ${e.formula ? `<met:formula>${e.formula}</met:formula>` : ""}
          <met:businessHours>${e.businessHours}</met:businessHours>
          <met:escalationStartDate>${e.escalationStartDate}</met:escalationStartDate>
          ${actionsXml}
        </met:ruleEntry>`;
      }).join("\n");
      const xml = `<met:metadata xsi:type="met:EscalationRules" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <met:fullName>Case</met:fullName>
        <met:escalationRule>
          <met:fullName>${params.ruleName}</met:fullName>
          <met:active>${params.active}</met:active>
          ${entriesXml}
        </met:escalationRule>
      </met:metadata>`;
      const { upsertMetadata } = await import("../services/salesforce.js");
      const result = await upsertMetadata(auth, xml);
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_auto_response_rule",
    {
      title: "Create Auto-Response Rule",
      description: `Creates an Auto-Response Rule for Web-to-Lead or Web-to-Case. When a lead or case is created via a web form, this rule automatically sends a confirmation email using the specified template. Rule entries define which template to use based on criteria.`,
      inputSchema: CreateAutoResponseRuleSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createAutoResponseRule(auth, {
        objectName: params.objectName,
        ruleName: params.ruleName,
        label: params.label,
        active: params.active,
        ruleEntries: params.ruleEntries,
      });
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_matching_rule",
    {
      title: "Create Matching Rule",
      description: `Creates a Matching Rule used by Duplicate Rules to detect potential duplicate records. Define which fields to match on and which matching algorithm to use (Exact, FirstName, LastName, Company, Email, Phone, etc.). Must be created before creating a Duplicate Rule that references it.`,
      inputSchema: CreateMatchingRuleSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createMatchingRule(auth, {
        objectName: params.objectName,
        ruleName: params.ruleName,
        label: params.label,
        description: params.description,
        matchingRuleItems: params.matchingRuleItems,
      });
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_duplicate_rule",
    {
      title: "Create Duplicate Rule",
      description: `Creates a Duplicate Rule that uses Matching Rules to detect potential duplicates when records are saved. Can block duplicates, allow with a warning, or allow silently. Works for Leads, Contacts, Accounts, and custom objects. Requires existing Matching Rules.`,
      inputSchema: CreateDuplicateRuleSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createDuplicateRule(auth, {
        objectName: params.objectName,
        ruleName: params.ruleName,
        label: params.label,
        description: params.description,
        isActive: params.isActive,
        actionOnInsert: params.actionOnInsert,
        actionOnUpdate: params.actionOnUpdate,
        alertMessage: params.alertMessage,
        matchingRules: params.matchingRules,
      });
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_apex_email_service",
    {
      title: "Create Apex Email Service",
      description: `Creates an Apex Email Service that processes inbound emails via an Apex class implementing Messaging.InboundEmailHandler. Useful for creating support cases from emails, parsing email content, or triggering workflows from inbound messages. The Apex class must exist before creating the service.`,
      inputSchema: CreateApexEmailServiceSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createApexEmailService(auth, {
        functionName: params.functionName,
        apexClassName: params.apexClassName,
        isActive: params.isActive,
        isAuthenticationRequired: params.isAuthenticationRequired,
        isErrorRoutingEnabled: params.isErrorRoutingEnabled,
        errorRoutingAddress: params.errorRoutingAddress,
        functionInactiveAction: params.functionInactiveAction,
        functionExceptionAction: params.functionExceptionAction,
        overLimitAction: params.overLimitAction,
        authenticationFailureAction: params.authenticationFailureAction,
        attachmentOption: params.attachmentOption,
      });
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_scheduled_job",
    {
      title: "Create Scheduled Apex Job",
      description: `Schedules an Apex class that implements the Schedulable interface to run on a cron schedule. Use for batch processing, nightly data cleanup, report generation, or any periodic automation. The Apex class must already exist in the org. Example cron: '0 0 2 * * ?' = daily at 2 AM.`,
      inputSchema: CreateScheduledJobSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createScheduledJob(auth, params.className, params.jobName, params.cronExpression);
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_scheduled_flow",
    {
      title: "Create Schedule-Triggered Flow",
      description: `Creates a Schedule-Triggered Flow that runs automatically on a recurring schedule (e.g., daily, weekly) against a batch of matching records. Use for nightly batch processing, periodic data updates, or scheduled notifications.

fullName: Flow API name
label: Flow display label
objectApiName: object whose records to process
scheduledPaths: array defining when the flow runs (offsetNumber, offsetUnit, timeSource)
description: optional description`,
      inputSchema: CreateScheduledFlowSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createScheduledFlow(auth, params);
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_platform_event_trigger",
    {
      title: "Create Platform Event Apex Trigger",
      description: `Creates an Apex trigger that fires when a Platform Event message is received (after insert). Use to process incoming platform events with Apex logic — e.g., creating records, sending notifications, or calling external APIs when an event is published.

triggerName: Apex trigger name
eventApiName: Platform event API name, e.g. 'MyEvent__e'
body: Apex code body for the trigger
apiVersion: Salesforce API version`,
      inputSchema: CreatePlatformEventTriggerSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createPlatformEventTrigger(auth, params);
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_workflow_rule",
    {
      title: "Create Workflow Rule",
      description: `Creates a Workflow Rule (legacy automation) that evaluates criteria and triggers actions. Use for simple automations that don't require the power of Flows. Supports formula or criteria-based evaluation. Workflow rules can trigger field updates, email alerts, outbound messages, and tasks.

objectName: object the rule applies to
fullName: rule developer name
triggerType: when to evaluate (onCreateOnly, onCreateOrTriggeringUpdate, onAllChanges)
active: whether the rule is active
formula or criteriaItems: define when the rule fires`,
      inputSchema: CreateWorkflowRuleSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createWorkflowRule(auth, params);
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_field_update",
    {
      title: "Create Workflow Field Update Action",
      description: `Creates a standalone Workflow Field Update action that sets a field to a formula, literal value, or null when triggered. Can be associated with Workflow Rules, Approval Process steps, or used independently.

objectName: object the field update applies to
fullName: developer name of the field update
name: display name
field: field API name to update
operation: Formula, Literal, LiteralBlank, or Null
formula: Apex formula (for Formula operation)
literalValue: static value to set (for Literal operation)`,
      inputSchema: CreateFieldUpdateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createFieldUpdate(auth, params);
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_create_outbound_message",
    {
      title: "Create Workflow Outbound Message",
      description: `Creates a Workflow Outbound Message that sends a SOAP XML payload to an external endpoint when triggered by a Workflow Rule or Approval Process. Use for real-time integration with external systems that need to be notified of record changes.

objectName: object the message is for
fullName: developer name for the outbound message
name: display name
endpointUrl: external SOAP endpoint URL
fields: field API names to include in the message
integrationUser: optional username to authenticate the callout`,
      inputSchema: CreateWorkflowOutboundMessageSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await createWorkflowOutboundMessage(auth, params);
      return resultContent(result);
    }
  );
}
