import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Lazy toolsets — keeps all 228 tools available while keeping most of them out of the model's
 * context window.
 *
 * Why this exists: a full `tools/list` on this server is ~362KB (~98k tokens) — roughly half a
 * 200k context window, spent before the user has typed anything, on every single session. That
 * cost is paid whether or not the session ever touches OmniStudio or DevOps Center, and a
 * 228-candidate tool list measurably degrades tool-selection accuracy. Salesforce's own MCP server
 * ships `--toolsets`/`--dynamic-tools` for the same reason at ~60 tools.
 *
 * How it works: every tool stays registered, so nothing is removed and no capability is lost.
 * Tools outside the active set are `disable()`d, which drops them from `tools/list` (the SDK
 * filters on `enabled`) while leaving them one call away. Enabling a group fires
 * `notifications/tools/list_changed` and the client refetches.
 *
 * The catch this design has to handle: the SDK rejects calls to disabled tools with a bare
 * "Tool X disabled". So `sf_find_tool` exists and auto-loads by default — a model that doesn't
 * know where something lives can search for it and have it enabled in a single round trip,
 * rather than dead-ending on an error it can't act on.
 */

export interface ToolsetInfo {
  /** Human-readable summary, shown in `sf_list_toolsets` and the loader's description. */
  description: string;
}

/** Descriptions for each toolset. Keys must match the group names used in `registerTools`. */
export const TOOLSET_INFO: Record<string, ToolsetInfo> = {
  core: { description: "Org discovery and deployment: describe object, list objects, SOQL query, deploy/retrieve/delete metadata, deploy status, dependency analysis. Loaded by default." },
  metadata: { description: "Core schema creation: custom objects, custom fields, formula fields, picklist values, validation rules, approval processes, workflow field updates. Loaded by default." },
  objects: { description: "Custom metadata types and records, custom labels, custom settings, global value sets, record types, business processes, page layouts, sharing rules, field dependencies" },
  data: { description: "Records and users: create/update/upsert/delete records, bulk insert/update/delete/import, export, SOSL search, users, public groups, queue members, data categories, external ID fields, update existing objects/fields" },
  flows: { description: "Flows — create (declarative or from XML), scheduled flows, activate, deactivate, list versions. Load this before building any Flow." },
  automation: { description: "Non-flow automation: workflow rules, field updates, email alerts, assignment/escalation/auto-response rules, matching and duplicate rules, platform events, scheduled jobs, outbound messages, Apex email services" },
  security: { description: "Permission sets, permission set groups, muting permission sets, custom permissions, roles, role hierarchy, queues, named credentials, field-level security" },
  apex: { description: "Apex classes, triggers, test classes, test runs, anonymous Apex, read existing Apex, anti-pattern and code scanning" },
  lwc: { description: "Lightning Web Components — create, update, generate from requirements, Jest tests, accessibility guidance, SLDS blueprints, Aura-to-LWC migration" },
  ui: { description: "Lightning apps, tabs, compact layouts, list views, email templates, static resources, custom notification types, report types, dashboards" },
  pages: { description: "Lightning pages (FlexiPages), path assistants, custom applications" },
  actions: { description: "Quick actions, global actions, custom buttons, field sets" },
  agentforce: { description: "Agentforce agents — bot shell, actions (GenAiFunction), topics (GenAiPlugin), planner wiring" },
  omnistudio: { description: "OmniStudio — OmniScripts, FlexCards, DataRaptors, Integration Procedures, calculation matrices and procedures, document generation, component import/export" },
  omnichannel: { description: "Omni-Channel and Service Cloud routing — service channels, routing configs, presence statuses, skills, service territories, work types, messaging channels, chat buttons, embedded service, bot routing" },
  devops: { description: "Scratch orgs, packages and package versions, package install/uninstall, DevOps Center work items, commits, promotions, pull requests, merge conflicts, code coverage" },
  deployment: { description: "Outbound change sets — create a change set and add components to it" },
  integrations: { description: "Connected apps, external client apps, external data sources, external objects, remote site settings, CSP trusted sites" },
  identity: { description: "Auth providers, SAML SSO configuration, connected app OAuth policies" },
  reports: { description: "Reports, report folders, folder sharing, dashboard updates" },
  experience: { description: "Experience Cloud sites and pages" },
  admin: { description: "User administration and org setup: role hierarchy, password reset, freeze user, territories, forecast hierarchy, search layouts, record-type layout assignment, custom tabs" },
  monitoring: { description: "Org limits, flow errors, Apex test results, deployment history, debug log capture and retrieval" },
  audit: { description: "Setup audit trail, login history, event log files, field history" },
  einstein: { description: "Einstein predictions, Next Best Action, Einstein bots" },
  knowledge: { description: "Knowledge article types, business hours, holidays" },
  cpq: { description: "Products, price books, entitlement processes, milestones" },
  sandbox: { description: "Sandboxes — create, refresh, list" },
  streaming: { description: "Push topics, Change Data Capture configuration, platform cache partitions" },
  visualforce: { description: "Visualforce pages, components and email templates" },
  aura: { description: "Aura components, apps and events" },
  comms: { description: "Letterheads and custom notification types" },
  mcp: { description: "Meta: scaffold MCP servers and tools, list tools in an MCP project" },
  i18n: { description: "Translations for custom labels and field labels" },
};

/**
 * Per-tool group overrides, applied after registration.
 *
 * The default grouping follows the src/tools/*.ts module a tool is registered in, which is mostly a
 * good taxonomy but not always: `metadata.ts` mixes core schema creation with sf_create_flow, and
 * the tools every session needs (describe, query, deploy, retrieve) are scattered across `data.ts`
 * and `deployment.ts`. These overrides fix that without moving code between modules.
 *
 * sf_create_flow matters most here: at 15,266 bytes (~4,126 tokens) it is by far the largest single
 * tool definition, and leaving it in a default-loaded group meant every session paid for the full
 * Flow element schema whether or not it ever built a flow.
 */
export const TOOL_GROUP_OVERRIDES: Record<string, string> = {
  // Universal — needed regardless of what the session is doing.
  sf_describe_object: "core",
  sf_list_objects: "core",
  sf_query_records: "core",
  sf_get_metadata_dependencies: "core",
  sf_deploy_metadata: "core",
  sf_retrieve_metadata: "core",
  sf_check_deploy_status: "core",
  sf_delete_metadata: "core",
  // Flow tools belong together, and sf_create_flow is too large to sit in a default toolset.
  sf_create_flow: "flows",
  sf_create_scheduled_flow: "flows",
};

/** Loaded unless `SF_TOOLSETS` says otherwise. Covers the operations most sessions start with. */
export const DEFAULT_TOOLSETS = ["core", "metadata"] as const;

interface ToolEntry {
  name: string;
  /** Mutable: TOOL_GROUP_OVERRIDES can reassign a tool after registration. */
  group: string;
  handle: RegisteredTool;
}

export class ToolsetRegistry {
  private readonly entries: ToolEntry[] = [];
  private server: McpServer | undefined;
  private readonly active = new Set<string>();
  /** Tools registered outside any group (the meta-tools) — always enabled, never listed as a group. */
  private readonly alwaysOn = new Set<string>();

  /**
   * Returns a stand-in for `server` that records every tool a register function creates and
   * attributes it to `group`. Using a Proxy keeps all 33 `register*Tools` modules untouched —
   * they still just call `server.registerTool(...)` and are unaware any of this exists.
   */
  capture(server: McpServer, group: string): McpServer {
    this.server = server;
    const entries = this.entries;
    return new Proxy(server, {
      get(target, prop, receiver) {
        if (prop === "registerTool") {
          // `registerTool` is heavily overloaded, so its parameters cannot be reproduced with
          // Parameters<> here. The proxy only needs to observe the call and pass it straight
          // through untouched, so an opaque signature is both sufficient and honest.
          type RegisterFn = (...args: unknown[]) => RegisteredTool;
          const original = (target.registerTool as unknown as RegisterFn).bind(target);
          return (...args: unknown[]): RegisteredTool => {
            const handle = original(...args);
            entries.push({ name: String(args[0]), group, handle });
            return handle;
          };
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
  }

  /**
   * Applies TOOL_GROUP_OVERRIDES. Called once after every module has registered, so that overrides
   * can reference tools regardless of which module happened to create them.
   */
  applyOverrides(): void {
    for (const entry of this.entries) {
      const override = TOOL_GROUP_OVERRIDES[entry.name];
      if (override) entry.group = override;
    }
  }

  markAlwaysOn(name: string): void {
    this.alwaysOn.add(name);
  }

  /** Toolset names, ordered as declared in TOOLSET_INFO so listings read consistently. */
  groups(): string[] {
    const present = new Set(this.entries.map((e) => e.group));
    const ordered = Object.keys(TOOLSET_INFO).filter((g) => present.has(g));
    const extras = [...present].filter((g) => !(g in TOOLSET_INFO));
    return [...ordered, ...extras];
  }

  countIn(group: string): number {
    return this.entries.filter((e) => e.group === group).length;
  }

  isActive(group: string): boolean {
    return this.active.has(group);
  }

  activeGroups(): string[] {
    return [...this.active];
  }

  totalTools(): number {
    return this.entries.length;
  }

  /** Number of tools currently visible in `tools/list`, meta-tools included. */
  residentTools(): number {
    return this.entries.filter((e) => this.active.has(e.group)).length + this.alwaysOn.size;
  }

  /**
   * Sets the active groups, enabling/disabling handles to match. Safe to call before the transport
   * is connected — the SDK guards `sendToolListChanged()` behind `isConnected()`, so startup does
   * not emit notifications to nobody.
   */
  setActive(groups: string[]): void {
    const known = new Set(this.groups());
    this.active.clear();
    for (const g of groups) {
      if (known.has(g)) this.active.add(g);
    }
    // Each enable()/disable() fires its own tools/list_changed. Toggling a group would emit one
    // notification per tool — 24 of them for a single sf_load_toolset call, and 24 client refetches
    // of a list that only changed once. Suppress the per-tool notification for the duration of the
    // batch and emit exactly one at the end.
    this.batched(() => {
      for (const entry of this.entries) {
        const shouldBeOn = this.active.has(entry.group);
        if (entry.handle.enabled !== shouldBeOn) {
          if (shouldBeOn) entry.handle.enable();
          else entry.handle.disable();
        }
      }
    });
  }

  /**
   * Runs `mutate` with the server's list-changed notification stubbed out, then sends a single
   * notification if anything actually changed. The stub is restored in a finally block so a throw
   * mid-batch cannot leave the server permanently unable to announce tool changes.
   */
  private batched(mutate: () => void): void {
    const server = this.server;
    if (!server) {
      mutate();
      return;
    }
    type Notifier = { sendToolListChanged: () => void };
    const target = server as unknown as Notifier;
    const original = target.sendToolListChanged.bind(server);
    let changed = false;
    target.sendToolListChanged = () => {
      changed = true;
    };
    try {
      mutate();
    } finally {
      target.sendToolListChanged = original;
    }
    if (changed) original();
  }

  enable(groups: string[]): { enabled: string[]; unknown: string[] } {
    const known = new Set(this.groups());
    const enabled: string[] = [];
    const unknown: string[] = [];
    for (const g of groups) {
      if (!known.has(g)) {
        unknown.push(g);
        continue;
      }
      if (!this.active.has(g)) enabled.push(g);
      this.active.add(g);
    }
    this.setActive([...this.active]);
    return { enabled, unknown };
  }

  disableGroups(groups: string[]): string[] {
    const removed: string[] = [];
    for (const g of groups) {
      if (this.active.delete(g)) removed.push(g);
    }
    this.setActive([...this.active]);
    return removed;
  }

  /** Case-insensitive substring match over tool names, across every group whether loaded or not. */
  search(query: string): { name: string; group: string; loaded: boolean }[] {
    const q = query.toLowerCase().replace(/[\s-]+/g, "_");
    const terms = q.split("_").filter((t) => t.length > 1);
    return this.entries
      .filter((e) => {
        const n = e.name.toLowerCase();
        return n.includes(q) || (terms.length > 0 && terms.every((t) => n.includes(t)));
      })
      .map((e) => ({ name: e.name, group: e.group, loaded: this.active.has(e.group) }));
  }

  /**
   * Resolves the `SF_TOOLSETS` env var into a starting set.
   * `all` loads everything (the pre-3.0 behaviour), `none` loads only the meta-tools, a
   * comma-separated list loads exactly those groups, and unset falls back to DEFAULT_TOOLSETS.
   */
  resolveInitial(raw: string | undefined): string[] {
    const value = (raw ?? "").trim().toLowerCase();
    if (value === "all" || value === "*") return this.groups();
    if (value === "none") return [];
    if (value.length > 0) {
      return value
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
    return [...DEFAULT_TOOLSETS];
  }
}

function summary(registry: ToolsetRegistry): string {
  return registry
    .groups()
    .map((g) => {
      const info = TOOLSET_INFO[g];
      const mark = registry.isActive(g) ? "[loaded]" : "        ";
      return `${mark} ${g} (${registry.countIn(g)}) — ${info ? info.description : "—"}`;
    })
    .join("\n");
}

function text(payload: unknown): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

/**
 * Registers the three always-on meta-tools. These are the only tools guaranteed to be present
 * regardless of configuration, so between them they have to make every other tool reachable.
 */
export function registerToolsetTools(server: McpServer, registry: ToolsetRegistry): void {
  const groupList = registry.groups().join(", ");

  const listTool = server.registerTool(
    "sf_list_toolsets",
    {
      title: "List Toolsets",
      description:
        `Lists every available Salesforce toolset, how many tools each contains, and which are currently loaded. ` +
        `This server keeps most of its ${registry.totalTools()} tools unloaded to save context; unloaded tools do not appear in the tool list ` +
        `until you load their toolset with sf_load_toolset. Call this when you need a capability you cannot see.`,
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    () =>
      text({
        totalTools: registry.totalTools(),
        residentTools: registry.residentTools(),
        loadedToolsets: registry.activeGroups(),
        toolsets: registry.groups().map((g) => ({
          name: g,
          tools: registry.countIn(g),
          loaded: registry.isActive(g),
          description: TOOLSET_INFO[g]?.description ?? "",
        })),
        hint: "Load with sf_load_toolset({ toolsets: [\"automation\"] }). Search across all toolsets with sf_find_tool.",
      }),
  );

  const loadTool = server.registerTool(
    "sf_load_toolset",
    {
      title: "Load Toolset",
      description:
        `Loads one or more Salesforce toolsets, making their tools callable and visible in the tool list. ` +
        `Available toolsets: ${groupList}. Call sf_list_toolsets for descriptions and tool counts.`,
      inputSchema: {
        toolsets: z
          .array(z.string())
          .min(1)
          .describe(`Toolset names to load. One or more of: ${groupList}`),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ toolsets }) => {
      const { enabled, unknown } = registry.enable(toolsets);
      return text({
        success: unknown.length === 0,
        newlyLoaded: enabled,
        alreadyLoaded: toolsets.filter((t) => !enabled.includes(t) && !unknown.includes(t)),
        ...(unknown.length > 0 ? { unknownToolsets: unknown, availableToolsets: registry.groups() } : {}),
        loadedToolsets: registry.activeGroups(),
        residentTools: registry.residentTools(),
        message:
          enabled.length > 0
            ? `Loaded ${enabled.join(", ")}. Their tools are now available.`
            : "No new toolsets loaded.",
      });
    },
  );

  const findTool = server.registerTool(
    "sf_find_tool",
    {
      title: "Find Tool",
      description:
        `Searches all ${registry.totalTools()} Salesforce tools by name — including tools in toolsets that are not loaded — and by default ` +
        `loads whichever toolsets contain the matches, so you can call them immediately. Use this whenever a tool you expect ` +
        `does not appear in the tool list, or when you do not know which toolset a capability lives in. ` +
        `Example queries: "flow", "permission set", "agent", "omniscript", "debug log".`,
      inputSchema: {
        query: z.string().min(2).describe('What you are looking for, e.g. "validation rule" or "create flow".'),
        autoLoad: z
          .boolean()
          .default(true)
          .describe("Load the toolsets containing the matches so they become callable straight away. Default true."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ query, autoLoad }) => {
      const matches = registry.search(query);
      if (matches.length === 0) {
        return text({
          matches: [],
          message: `No tool name matched "${query}". Call sf_list_toolsets to browse toolsets by capability.`,
          availableToolsets: registry.groups(),
        });
      }
      const groupsNeeded = [...new Set(matches.filter((m) => !m.loaded).map((m) => m.group))];
      let loaded: string[] = [];
      if (autoLoad !== false && groupsNeeded.length > 0) {
        loaded = registry.enable(groupsNeeded).enabled;
      }
      return text({
        matches: matches.map((m) => ({ tool: m.name, toolset: m.group })),
        ...(loaded.length > 0 ? { loadedToolsets: loaded } : {}),
        ...(autoLoad === false && groupsNeeded.length > 0 ? { loadWith: groupsNeeded } : {}),
        residentTools: registry.residentTools(),
        message:
          loaded.length > 0
            ? `Found ${matches.length} tool(s) and loaded ${loaded.join(", ")} — they are callable now.`
            : `Found ${matches.length} tool(s), all already loaded.`,
      });
    },
  );

  for (const t of [listTool, loadTool, findTool]) {
    void t;
  }
  registry.markAlwaysOn("sf_list_toolsets");
  registry.markAlwaysOn("sf_load_toolset");
  registry.markAlwaysOn("sf_find_tool");
}

export { summary as toolsetSummary };
