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
  metadata: { description: "Deploy/retrieve/delete metadata, describe objects, list objects, dependency analysis" },
  objects: { description: "Custom objects, fields, formula fields, record types, field dependencies, picklists" },
  data: { description: "Records: query (SOQL), search (SOSL), create, update, upsert, delete, bulk operations, export" },
  automation: { description: "Flows, validation rules, approval processes, assignment/escalation/auto-response rules, duplicate & matching rules, workflow" },
  security: { description: "Permission sets, permission set groups, profiles, roles, sharing rules, queues, public groups, field-level security" },
  apex: { description: "Apex classes, triggers, test classes, test runs, code coverage, anonymous Apex, code scanning" },
  lwc: { description: "Lightning Web Components — create, update, Jest tests, accessibility, Aura-to-LWC migration" },
  ui: { description: "Page layouts, Lightning pages (FlexiPages), compact layouts, list views, tabs, apps, search layouts" },
  agentforce: { description: "Agentforce agents — bot shell, actions (GenAiFunction), topics (GenAiPlugin), planner wiring" },
  omnistudio: { description: "OmniStudio — OmniScripts, FlexCards, DataRaptors, Integration Procedures, calculation matrices/procedures" },
  omnichannel: { description: "Omni-Channel — service channels, routing configs, presence statuses, queues, skills, chat buttons, messaging" },
  devops: { description: "DevOps Center — projects, work items, commits, promotions, pull requests, merge conflicts" },
  deployment: { description: "Change sets, packages, package versions, deploy status, deployment history, package install/uninstall" },
  integrations: { description: "Named credentials, external data sources, external objects, remote site settings, auth providers, outbound messages" },
  reports: { description: "Reports, report types, report folders, dashboards, folder sharing" },
  experience: { description: "Experience Cloud sites and pages" },
  admin: { description: "Users, roles, business hours, holidays, custom labels/settings/metadata types, notifications" },
  monitoring: { description: "Debug logs, event logs, login history, org limits, setup audit trail, flow errors, field history" },
  einstein: { description: "Einstein bots, predictions, Next Best Action" },
  actions: { description: "Quick actions, global actions, custom buttons, path assistants" },
  pages: { description: "Static resources, CSP settings, letterheads, documents" },
  audit: { description: "Field history tracking, change data capture, platform cache, scheduled jobs" },
  cpq: { description: "Products, price books, forecasting, territories" },
  knowledge: { description: "Knowledge article types, data categories, entitlement processes, milestones" },
  identity: { description: "Connected apps, external client apps, SAML SSO, OAuth policies" },
  sandbox: { description: "Sandboxes and scratch orgs — create, list, refresh, delete" },
  streaming: { description: "Platform events, push topics, platform event triggers" },
  visualforce: { description: "Visualforce pages, components, email templates" },
  aura: { description: "Aura components, apps and events" },
  flows: { description: "Flow lifecycle — list versions, activate, deactivate, create from XML" },
  comms: { description: "Email templates, email alerts, send email, Apex email services" },
  mcp: { description: "Meta: scaffold MCP servers and tools, SLDS blueprints" },
  i18n: { description: "Translations for custom labels and field labels" },
};

/** Loaded unless `SF_TOOLSETS` says otherwise. Covers the operations most sessions start with. */
export const DEFAULT_TOOLSETS = ["metadata", "objects"] as const;

interface ToolEntry {
  name: string;
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

  markAlwaysOn(name: string): void {
    this.alwaysOn.add(name);
  }

  groups(): string[] {
    return [...new Set(this.entries.map((e) => e.group))];
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
