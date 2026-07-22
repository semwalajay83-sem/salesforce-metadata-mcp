import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CreateApexClassSchema,
  CreateApexTriggerSchema,
  CreateApexTestClassSchema,
  RunApexTestsSchema,
  ExecuteAnonymousApexSchema,
  ScanApexAntipatternsSchema,
  GetApexClassSchema,
  GetApexTriggerSchema,
} from "../schemas/index.js";
import { getAuth, scanApexAntipatterns, getApexClass, getApexTrigger } from "../services/salesforce.js";
import {
  buildApexClassZip,
  buildApexTriggerZip,
  deployZip,
  pollDeployStatus,
} from "../services/deployment.js";
import {
  executeAnonymousApex,
  runApexTests,
} from "../services/tooling.js";
import { resultContent } from "./utils.js";

export function registerApexTools(server: McpServer): void {

  server.registerTool(
    "sf_create_apex_class",
    {
      title: "Create Apex Class",
      description: `Creates and deploys an Apex class to the Salesforce org using the Metadata API. Accepts the full Apex source code including the class declaration. Use for any type of Apex class: service classes, controllers, batch classes, schedulable classes, queueable classes, test utilities, etc. IMPORTANT — If this class will be used as an Agentforce agent action: it MUST contain a public static method annotated with @InvocableMethod. Classes without @InvocableMethod cannot be invoked by agents and will silently fail at runtime. Example minimum structure: public class MyClass { @InvocableMethod(label='Do Thing' description='Does the thing') public static List<String> doThing(List<String> input) { ... } }`,
      inputSchema: CreateApexClassSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      try {
        const base64Zip = await buildApexClassZip(params.className, params.classBody, params.apiVersion);
        const deployId = await deployZip(auth, base64Zip);
        const result = await pollDeployStatus(auth, deployId, 5 * 60 * 1000);
        if (result.success) {
          return resultContent({ success: true, message: `Apex class '${params.className}' deployed successfully.`, fullName: params.className, created: true });
        }
        return resultContent(result);
      } catch (err: unknown) {
        return resultContent({ success: false, message: err instanceof Error ? err.message : String(err) });
      }
    }
  );

  server.registerTool(
    "sf_create_apex_trigger",
    {
      title: "Create Apex Trigger",
      description: `Creates and deploys an Apex Trigger on any Salesforce object. Specify the trigger events (before insert, after update, etc.) and the trigger body code. The trigger declaration (trigger Name on Object (events)) is auto-generated — just provide the code that goes inside the trigger body. Deployed via Metadata API SOAP deploy.`,
      inputSchema: CreateApexTriggerSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      try {
        const base64Zip = await buildApexTriggerZip(
          params.triggerName,
          params.objectName,
          params.events,
          params.triggerBody,
          params.apiVersion
        );
        const deployId = await deployZip(auth, base64Zip);
        const result = await pollDeployStatus(auth, deployId, 5 * 60 * 1000);
        if (result.success) {
          return resultContent({ success: true, message: `Apex trigger '${params.triggerName}' deployed on ${params.objectName}.`, fullName: params.triggerName, created: true });
        }
        return resultContent(result);
      } catch (err: unknown) {
        return resultContent({ success: false, message: err instanceof Error ? err.message : String(err) });
      }
    }
  );

  server.registerTool(
    "sf_create_apex_test_class",
    {
      title: "Create Apex Test Class",
      description: `Creates and deploys an Apex Test Class (annotated with @isTest). Provide the full test class source code. Optionally run the tests immediately after deployment. Test classes are required for Salesforce deployments to production (minimum 75% code coverage). Use for unit testing Apex classes, triggers, and business logic.`,
      inputSchema: CreateApexTestClassSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      try {
        const base64Zip = await buildApexClassZip(params.className, params.classBody, params.apiVersion);
        const deployId = await deployZip(auth, base64Zip);
        const deployResult = await pollDeployStatus(auth, deployId, 5 * 60 * 1000);
        if (!deployResult.success) return resultContent(deployResult);

        if (params.runAfterDeploy) {
          const testResult = await runApexTests(auth, [params.className], 5);
          return resultContent({
            success: testResult.success,
            message: `Test class '${params.className}' deployed. ${testResult.message}`,
            ...(testResult.success ? { fullName: params.className, created: true } : {})
          });
        }
        return resultContent({ success: true, message: `Test class '${params.className}' deployed successfully.`, fullName: params.className, created: true });
      } catch (err: unknown) {
        return resultContent({ success: false, message: err instanceof Error ? err.message : String(err) });
      }
    }
  );

  server.registerTool(
    "sf_run_apex_tests",
    {
      title: "Run Apex Tests",
      description: `Runs one or more Apex test classes and returns pass/fail results with any error messages. Uses the Salesforce Tooling API runTestsAsynchronous endpoint and polls for results. Use after deploying Apex code to verify test coverage, or to run regression tests before a release.`,
      inputSchema: RunApexTestsSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await runApexTests(auth, params.testClasses, params.waitMinutes);
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_execute_anonymous_apex",
    {
      title: "Execute Anonymous Apex",
      description: `Executes anonymous Apex code in the Salesforce org using the Tooling API executeAnonymous endpoint. Returns compile errors, runtime exceptions, and debug log output. Use for one-off data fixes, testing Apex snippets, creating test data, running utilities, or debugging. Code runs in the context of the authenticated user.`,
      inputSchema: ExecuteAnonymousApexSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await executeAnonymousApex(auth, params.apexCode);
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_scan_apex_antipatterns",
    {
      title: "Scan Apex for Anti-Patterns",
      description: `Scans Apex classes in the org for common anti-patterns using the Tooling API. Detects SOQL/DML in loops, hardcoded Salesforce IDs, and debug statements left in production code. Use before deploying to catch performance and quality issues early.

classNames: optional list of class names to scan (omits test classes with __Test suffix)
maxClasses: maximum classes to scan (default 20, max 200)`,
      inputSchema: ScanApexAntipatternsSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await scanApexAntipatterns(auth, params);
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_get_apex_class",
    {
      title: "Get Apex Class Source",
      description: `Retrieves the full source code of an existing Apex class by exact name, via the Tooling API. Use before modifying a class (to see current logic), when debugging, or when a user asks "show me the X class" / "what does this class do". Returns the class body, API version, and status. Not to be confused with sf_create_apex_class, which deploys new or updated code — this tool only reads.`,
      inputSchema: GetApexClassSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await getApexClass(auth, params);
      return resultContent(result);
    }
  );

  server.registerTool(
    "sf_get_apex_trigger",
    {
      title: "Get Apex Trigger Source",
      description: `Retrieves the full source code of an existing Apex trigger by exact name, via the Tooling API. Returns the trigger body, the object it fires on, its active status, and which trigger events (before/after insert/update/delete/undelete) it's registered for. Use before modifying a trigger, or when a user asks to see or explain an existing trigger.`,
      inputSchema: GetApexTriggerSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const auth = await getAuth();
      const result = await getApexTrigger(auth, params);
      return resultContent(result);
    }
  );
}
