# Recipes

Each recipe assumes the workflow in SKILL.md §2 (inspect → confirm → create → verify → grant
access). Tool names are given so you can call them directly or via `sf_call_tool`.

## New custom object with fields and access

1. `sf_list_objects` — make sure the name isn't taken.
2. `sf_create_custom_object` — label, plural label, name field (text or auto-number), sharing model.
3. `sf_create_custom_field` per field; `sf_create_formula_field` for formulas;
   `sf_add_picklist_values` to extend an existing picklist.
4. `sf_describe_object` to confirm every field exists with the right type.
5. Load `security`, create a permission set with object CRUD + field access, offer to assign it.
6. Optional: load `ui` for a tab and list view so users can find the object.

## Validation rule

1. `sf_describe_object` — get exact field API names and types.
2. Write the error-condition formula (it fires when TRUE). Explain it in plain English to the user.
3. `sf_create_validation_rule` with a clear error message and, where possible, an error field.
4. Suggest a test: a record that should fail and one that should pass.

## Record-triggered flow

1. `sf_load_toolset` → `flows` (the flow tool is large and not loaded by default).
2. Confirm trigger object, before-save vs after-save, entry conditions, and run-once-per-change.
3. Prefer before-save for same-record field updates (faster, no extra DML).
4. `sf_create_flow`, then check for errors. `status` defaults to `Draft` — ask before setting it to
   `Active` (or activating afterwards). Flows used by Agentforce actions MUST be `Active`.

## Apex class with test

1. Load `apex`. Check for existing classes with `sf_find_tool` → read tools before creating duplicates.
2. Create the class, then a test class that asserts behaviour (not just coverage). Bulkify: no SOQL
   or DML inside loops.
3. Run the tests and report pass/fail and coverage. Production deploys need 75% org-wide coverage.

## Permission set

1. Load `security`.
2. Create the permission set; add object permissions, field permissions, tabs and Apex class access
   as needed. Prefer permission sets and permission set groups over editing profiles.
3. Assign only after the user confirms who gets it.

## Report

1. Load `reports`. Confirm the report type exists for the objects involved (create one via `ui` if not).
2. Create a folder if needed, then the report with filters, grouping and columns the user asked for.

## Agentforce agent

1. Load `agentforce`. Confirm the org has Agentforce enabled and the needed licences.
2. Follow this exact order — each step depends on the previous one:
   1. Backing flows (`sf_create_flow`, `flowType=AutoLaunchedFlow`, `status=Active`) and/or Apex classes.
   2. `sf_create_agent` — the agent shell. `agentType` is Employee (default) or Service and
      **cannot be changed later**, so confirm it first.
   3. `sf_create_agent_action` — one call per flow/Apex class.
   4. `sf_create_agent_topic` — groups the actions; must come after them.
   5. `sf_create_agent_planner` — lists the topics; must come after them.
   6. `sf_create_agent` again with `plannerName` — links the agent to the planner (safe to re-run).
3. If you get `DUPLICATE_DEVELOPER_NAME` on a brand-new name, the org usually has leftover agent
   metadata from earlier attempts — suggest cleaning up old test agents in Setup rather than retrying.
4. Tell the user to test in Agent Builder and activate there.

## Impact analysis before a change ("what breaks if I change X?")

1. `sf_get_metadata_dependencies` on the field, object or class.
2. `sf_describe_object` for formula and lookup references.
3. Summarise: flows, Apex, layouts, reports, validation rules that reference it — and recommend
   whether to proceed, migrate data first, or deprecate instead of delete.
