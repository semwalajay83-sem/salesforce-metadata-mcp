import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CreateNewScratchOrgSchema,
  DeleteScratchOrgSchema,
  CreatePackageSchema,
  CreatePackageVersionSchema,
  InstallPackageSchema,
  DevOpsCreateWorkItemSchema,
  DevOpsPromoteWorkItemSchema,
  CheckCodeCoverageSchema,
  DetectDevOpsMergeConflictSchema,
  ResolveDevOpsMergeConflictSchema,
  CheckoutDevOpsWorkItemSchema,
  CommitDevOpsWorkItemSchema,
  CreateDevOpsPullRequestSchema,
  ListDevOpsProjectsSchema,
  ListDevOpsWorkItemsSchema,
  CheckDevOpsCommitStatusSchema,
  PromoteDevOpsWorkItemSchema,
} from "../schemas/index.js";
import {
  getAuth,
  createNewScratchOrg,
  deleteScratchOrg,
  createPackage,
  createPackageVersion,
  installPackage,
  devOpsCreateWorkItem,
  devOpsPromoteWorkItem,
  checkCodeCoverage,
  detectDevOpsMergeConflict,
  resolveDevOpsMergeConflict,
  checkoutDevOpsWorkItem,
  commitDevOpsWorkItem,
  createDevOpsPullRequest,
  listDevOpsProjects,
  listDevOpsWorkItems,
  checkDevOpsCommitStatus,
  promoteDevOpsWorkItem,
} from "../services/salesforce.js";
import { resultContent } from "./utils.js";

export function registerDevOpsTools(server: McpServer): void {
  server.registerTool("sf_create_scratch_org", {
    title: "Create Scratch Org",
    description: `Creates a Salesforce scratch org using the SF CLI. Scratch orgs are temporary, configurable environments for development and testing. Requires a Dev Hub org to be authorized.

definitionFile: path to project-scratch-def.json (optional, defaults to CLI default)
alias: alias for the scratch org
duration: number of days before expiry (1–30)
devHubAlias: Dev Hub org alias`,
    inputSchema: CreateNewScratchOrgSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await createNewScratchOrg(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_delete_scratch_org", {
    title: "Delete Scratch Org",
    description: `Deletes a Salesforce scratch org by alias. This permanently removes the org and all its data. Use when finished with development or testing to free up scratch org allocations.

alias: alias of the scratch org to delete
noPrompt: skip the confirmation prompt (default: true)`,
    inputSchema: DeleteScratchOrgSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await deleteScratchOrg(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_create_package", {
    title: "Create Second-Generation Package",
    description: `Creates a second-generation managed or unlocked package using the SF CLI. Packages bundle metadata for distribution. Managed packages support namespacing and AppExchange listing; unlocked packages support source-tracking without namespacing.

name: package name
packageType: Managed or Unlocked
path: source path for the package, e.g. 'force-app'
description: optional description
noNamespace: create without a namespace (Unlocked packages only)`,
    inputSchema: CreatePackageSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await createPackage(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_create_package_version", {
    title: "Create Package Version",
    description: `Creates a new version of an existing second-generation package. Each version captures the current state of the package source. Package versions can be promoted and installed in target orgs.

packageId: Package ID (0Ho...) or package alias
installationKey: optional key to protect the version
codeVersion: version number, e.g. '1.0.0.NEXT'
wait: minutes to wait for version creation to complete`,
    inputSchema: CreatePackageVersionSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await createPackageVersion(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_install_package", {
    title: "Install Package",
    description: `Installs a package version into a target org using the SF CLI. Supports both managed and unlocked packages. Requires the package version ID (04t...) or an alias.

packageId: package version ID (04t...) or alias
targetOrg: target org alias (defaults to SF_ALIAS env var)
installationKey: installation key if the package version is protected
wait: minutes to wait for installation to complete`,
    inputSchema: InstallPackageSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await installPackage(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_devops_create_work_item", {
    title: "Create DevOps Center Work Item",
    description: `Creates a work item in Salesforce DevOps Center. Work items represent units of work (features, bug fixes, etc.) that move through pipeline stages from development to production.

name: work item name/title
description: optional description
pipelineStageId: optional pipeline stage ID to assign to
assignedToId: optional user ID to assign the work item to`,
    inputSchema: DevOpsCreateWorkItemSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await devOpsCreateWorkItem(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_devops_promote_work_item", {
    title: "Promote DevOps Center Work Item",
    description: `Promotes a DevOps Center work item to the next pipeline stage. Moving work items through the pipeline represents the progression of changes from development environments toward production.

workItemId: the DevOps Center work item record ID`,
    inputSchema: DevOpsPromoteWorkItemSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await devOpsPromoteWorkItem(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_check_code_coverage", {
    title: "Check Apex Code Coverage",
    description: `Retrieves Apex code coverage statistics from the org using the Tooling API. Shows which classes meet or fail the 75% coverage threshold required for deployment. Use after running Apex tests to assess coverage.

className: optional filter to show only classes matching this name
minCoverage: optional threshold — only return classes below this coverage percentage`,
    inputSchema: CheckCodeCoverageSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await checkCodeCoverage(auth, params);
    return resultContent(result);
  });

  // ─── Category 9: DevOps Center Operations ────────────────────────────────────

  server.registerTool("sf_detect_devops_merge_conflict", {
    title: "Detect DevOps Center Merge Conflicts",
    description: `Checks a DevOps Center work item for merge conflicts. Returns the work item details and any associated merge conflict records. Use before promoting a work item to identify conflicts that need resolution.

workItemId: DevOps Center work item ID`,
    inputSchema: DetectDevOpsMergeConflictSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await detectDevOpsMergeConflict(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_resolve_devops_merge_conflict", {
    title: "Resolve DevOps Center Merge Conflict",
    description: `Marks a merge conflict in DevOps Center as resolved with a specified resolution strategy. Use after manually resolving conflicts in the source control system.

conflictId: merge conflict record ID
resolution: resolution strategy — 'ours' (keep our changes), 'theirs' (accept incoming), or 'manual' (already resolved)`,
    inputSchema: ResolveDevOpsMergeConflictSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await resolveDevOpsMergeConflict(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_checkout_devops_work_item", {
    title: "Checkout DevOps Center Work Item",
    description: `Checks out a DevOps Center work item, moving it to 'In Progress' status. This signals that a developer is actively working on the changes for this work item.

workItemId: DevOps Center work item ID to check out`,
    inputSchema: CheckoutDevOpsWorkItemSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await checkoutDevOpsWorkItem(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_commit_devops_work_item", {
    title: "Commit DevOps Center Work Item",
    description: `Commits changes for a DevOps Center work item by creating a commit record associated with the work item. Records the commit message for audit tracking.

workItemId: DevOps Center work item ID
message: commit message describing the changes`,
    inputSchema: CommitDevOpsWorkItemSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await commitDevOpsWorkItem(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_create_devops_pull_request", {
    title: "Create DevOps Center Pull Request",
    description: `Creates a pull request record for a DevOps Center work item. Pull requests represent code review requests before merging changes to a target branch or pipeline stage.

workItemId: DevOps Center work item ID
title: pull request title
description: optional pull request description`,
    inputSchema: CreateDevOpsPullRequestSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await createDevOpsPullRequest(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_list_devops_projects", {
    title: "List DevOps Center Projects",
    description: `Lists all DevOps Center projects in the org. Returns project names, IDs, and associated pipeline information. Use to discover project IDs needed for other DevOps Center operations.`,
    inputSchema: ListDevOpsProjectsSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await listDevOpsProjects(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_list_devops_work_items", {
    title: "List DevOps Center Work Items",
    description: `Lists DevOps Center work items, optionally filtered by project or pipeline stage. Use to get an overview of work in progress.

projectId: optional filter by DevOps Center project ID
stageId: optional filter by pipeline stage ID
limit: maximum records to return (default: 20)`,
    inputSchema: ListDevOpsWorkItemsSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await listDevOpsWorkItems(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_check_devops_commit_status", {
    title: "Check DevOps Center Commit Status",
    description: `Retrieves the commit and deployment status for a DevOps Center work item. Shows recent commits and their deployment outcomes.

workItemId: DevOps Center work item ID`,
    inputSchema: CheckDevOpsCommitStatusSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await checkDevOpsCommitStatus(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_promote_devops_work_item", {
    title: "Promote DevOps Center Work Item to Stage",
    description: `Promotes a DevOps Center work item to a specific pipeline stage by ID. Use to move work items forward in the pipeline when you know the exact target stage.

workItemId: DevOps Center work item ID
targetStageId: ID of the target pipeline stage`,
    inputSchema: PromoteDevOpsWorkItemSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await promoteDevOpsWorkItem(auth, params);
    return resultContent(result);
  });
}
