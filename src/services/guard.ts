import { getAuth, queryRecords, sanitizeError } from "./salesforce.js";

/**
 * Production write guard.
 *
 * The threat this exists for is not a careless user — it is prompt injection. This server hands an
 * LLM a Salesforce credential that is very often System Admin, and the LLM decides what to do with
 * it. Any text the model reads along the way (a case comment, a field description, a retrieved
 * .flow file, an email body) can carry an instruction, and nothing downstream can tell that
 * instruction apart from one the human actually typed. Salesforce's own hosted MCP servers ship a
 * blunt version of the same idea: they will create and update records but refuse to delete, and
 * deletes live behind a separate server you have to opt into.
 *
 * Scope was chosen deliberately and is narrower than "all writes":
 *
 *  - Metadata CREATION is never blocked. All 137 sf_create_* tools, sf_deploy_metadata and
 *    sf_retrieve_metadata work against production exactly as before. Authoring metadata by natural
 *    language is the entire point of this package, and a guard that taxes it would be turned off
 *    on day one — which is worse than no guard, because it would be turned off for everything.
 *
 *  - Apex authoring (sf_create_apex_class / sf_create_apex_trigger) is NOT blocked, even though a
 *    trigger is arbitrary code that runs on every DML. Apex is the escape hatch for everything
 *    declarative automation cannot do, so blocking it would remove the capability people come here
 *    for. The security line drawn instead is auditability: created Apex is *metadata* — it has a
 *    name, an author, a deploy record, and it can be found and removed afterwards.
 *    sf_execute_anonymous_apex leaves no artifact at all, so that one IS blocked. This is a real
 *    residual risk and is documented as such rather than papered over.
 *
 * What remains blocked on production is the set that destroys data, runs untraceable code, or
 * changes who can log in — none of which any metadata-authoring session needs.
 */

/** Tools refused against a production org unless the guard is explicitly lowered. */
export const DESTRUCTIVE_TOOLS = new Set([
  // Irreversible data / metadata loss.
  "sf_delete_metadata",
  "sf_delete_record",
  "sf_bulk_delete_records",
  "sf_uninstall_package",
  // Arbitrary code with no artifact left behind. Contrast sf_create_apex_* which are auditable.
  "sf_execute_anonymous_apex",
  // Identity and access — privilege escalation and account takeover.
  "sf_create_user",
  "sf_update_user",
  "sf_reset_user_password",
  "sf_freeze_user",
]);

export type GuardMode = "destructive" | "strict" | "off";

/**
 * `destructive` (default) refuses DESTRUCTIVE_TOOLS on production. `strict` refuses every
 * non-read tool on production. `off` disables the guard entirely.
 *
 * The default is `destructive` rather than `strict` because v3.0.0 already carries one breaking
 * change (lazy toolsets) and stacking a second — silently turning production read-only for every
 * existing config — would be a bad trade for a release people need to trust.
 */
export function guardMode(): GuardMode {
  const raw = (process.env["SF_PRODUCTION_GUARD"] ?? "").trim().toLowerCase();
  if (raw === "off" || raw === "strict" || raw === "destructive") return raw;
  if (raw) {
    console.error(
      `Ignoring SF_PRODUCTION_GUARD='${raw}' — expected 'destructive', 'strict' or 'off'. Using 'destructive'.`,
    );
  }
  return "destructive";
}

interface OrgIdentity {
  isProduction: boolean;
  label: string;
}

let cachedOrg: OrgIdentity | null = null;
let orgLookup: Promise<OrgIdentity> | null = null;

/**
 * Resolves whether the connected org is production.
 *
 * `IsSandbox = false` is NOT sufficient on its own, and getting this wrong is what would make the
 * feature unusable: Developer Edition orgs and scratch orgs both report IsSandbox = false. Gating
 * a dev org on every call would get the guard disabled permanently, so all three signals are
 * required before an org is treated as production.
 *
 * Fails CLOSED. If the org cannot be identified, it is treated as production — an unidentifiable
 * org is exactly the case where a destructive call should not proceed on a guess. Every tool this
 * gates is one a user can still run by setting SF_PRODUCTION_GUARD=off, so a false positive costs
 * an env var; a false negative costs a production org.
 */
async function resolveOrg(): Promise<OrgIdentity> {
  if (cachedOrg) return cachedOrg;
  if (orgLookup) return orgLookup;

  orgLookup = (async (): Promise<OrgIdentity> => {
    try {
      const auth = await getAuth();
      const res = (await queryRecords(auth, {
        soql: "SELECT Name, IsSandbox, OrganizationType, TrialExpirationDate FROM Organization LIMIT 1",
      })) as {
        success: boolean;
        records?: {
          Name?: string;
          IsSandbox?: boolean;
          OrganizationType?: string;
          TrialExpirationDate?: string | null;
        }[];
        message?: string;
      };

      const org = res.success ? res.records?.[0] : undefined;
      if (!org) {
        return { isProduction: true, label: "unidentified org (treated as production)" };
      }

      const isSandbox = org.IsSandbox === true;
      const isDeveloper = (org.OrganizationType ?? "").toLowerCase().includes("developer");
      const isTrial = org.TrialExpirationDate != null;
      const isProduction = !isSandbox && !isDeveloper && !isTrial;

      const kind = isSandbox ? "sandbox" : isDeveloper ? "developer" : isTrial ? "trial/scratch" : "PRODUCTION";
      return { isProduction, label: `${org.Name ?? "org"} (${kind})` };
    } catch (err) {
      console.error(
        "Production guard could not identify the org, treating it as production:",
        sanitizeError(err instanceof Error ? err.message : String(err)),
      );
      return { isProduction: true, label: "unidentified org (treated as production)" };
    } finally {
      orgLookup = null;
    }
  })();

  cachedOrg = await orgLookup;
  return cachedOrg;
}

/**
 * Returns a refusal message if `toolName` must not run against the connected org, or null to allow.
 *
 * Deliberately a hard refusal rather than a confirmation prompt: a prompt that the calling agent
 * can satisfy by itself is not a control at all, and this server is routinely run under Claude
 * Code with permissions bypassed. Only an environment variable — something the human set outside
 * the conversation — lifts it.
 */
/**
 * Parameter names that redirect a tool at a different org than the ambient credentials.
 *
 * Found by attacking the guard 2026-08-28. `sf_uninstall_package` is gated, but
 * `uninstallPackage()` ignores its `auth` argument entirely and shells out to
 * `sf package uninstall --target-org <params.targetOrg>`. The guard resolved production-ness from
 * `getAuth()` — a completely different org — so pointing SF_INSTANCE_URL at a dev org and passing
 * `targetOrg: "<prod-alias>"` sailed straight through a guard that believed it was protecting
 * production. Any org named this way is unverifiable from here without a second CLI round-trip, so
 * a gated tool carrying one is refused rather than guessed at.
 */
const ORG_OVERRIDE_PARAMS = ["targetOrg", "targetAlias", "targetOrgAlias", "orgAlias"] as const;

function orgOverride(params: unknown): string | null {
  if (typeof params !== "object" || params === null) return null;
  const record = params as Record<string, unknown>;
  for (const key of ORG_OVERRIDE_PARAMS) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return key;
  }
  return null;
}

export async function checkProductionGuard(
  toolName: string,
  isReadOnly: boolean,
  params?: unknown,
): Promise<string | null> {
  const mode = guardMode();
  if (mode === "off") return null;
  if (isReadOnly) return null;

  const gated = mode === "strict" ? true : DESTRUCTIVE_TOOLS.has(toolName);
  if (!gated) return null;

  // Checked before the org lookup: when a call names its own org, the org this process is
  // authenticated to is not the org that will be affected, so resolving it would answer the wrong
  // question and answer it reassuringly.
  const override = orgOverride(params);
  if (override !== null) {
    return (
      `Blocked by the production write guard: '${toolName}' was called with an explicit '${override}', ` +
      `which redirects it to an org this server cannot verify is non-production. ` +
      `Remove '${override}' to run against the configured org, or set SF_PRODUCTION_GUARD=off if the target is known to be safe.`
    );
  }

  const org = await resolveOrg();
  if (!org.isProduction) return null;

  const lift =
    mode === "strict"
      ? "SF_PRODUCTION_GUARD=destructive (block only destructive tools) or SF_PRODUCTION_GUARD=off"
      : "SF_PRODUCTION_GUARD=off";

  return (
    `Blocked by the production write guard: '${toolName}' is not permitted against ${org.label}. ` +
    `This tool destroys data, runs untraceable code, or changes org access, and the connected org is production. ` +
    `Metadata creation is unaffected — sf_create_* tools and sf_deploy_metadata still work here. ` +
    `To allow this, the operator must set ${lift} in the server's environment and restart it. ` +
    `Do not attempt to work around this by using another tool.`
  );
}

/** Test seam: forget the cached org identity. */
export function resetGuardCache(): void {
  cachedOrg = null;
  orgLookup = null;
}
