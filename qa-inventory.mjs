/**
 * Dumps the live tool inventory (name, annotations, required params, param types) to JSON.
 * This is the backbone the full sweep builds fixtures against. Run with SF_TOOLSETS=all.
 */
import { writeFileSync } from "node:fs";
import { startServer } from "./qa-lib.mjs";

const s = startServer({ env: { SF_TOOLSETS: "all" } });
await s.initialize();
const tools = await s.listTools();

const inv = tools.map((t) => {
  const schema = t.inputSchema ?? {};
  const props = schema.properties ?? {};
  return {
    name: t.name,
    annotations: t.annotations ?? {},
    required: schema.required ?? [],
    params: Object.fromEntries(Object.entries(props).map(([k, v]) => [
      k,
      { type: v.type ?? (v.anyOf ? "anyOf" : "?"), enum: v.enum, desc: (v.description ?? "").slice(0, 120) },
    ])),
  };
});

writeFileSync("qa-inventory.json", JSON.stringify(inv, null, 2));
console.log(`tools: ${inv.length}`);
console.log(`readOnly: ${inv.filter((t) => t.annotations.readOnlyHint).length}`);
console.log(`destructive: ${inv.filter((t) => t.annotations.destructiveHint).length}`);
s.stop();
