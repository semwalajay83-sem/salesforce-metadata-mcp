import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CreateProductSchema,
  CreatePriceBookSchema,
  CreateEntitlementProcessSchema,
  CreateMilestoneSchema,
} from "../schemas/index.js";
import {
  getAuth,
  createProduct,
  createPriceBook,
  createEntitlementProcess,
  createMilestone,
} from "../services/salesforce.js";
import { resultContent } from "./utils.js";

export function registerCpqTools(server: McpServer): void {
  server.registerTool("sf_create_product", {
    title: "Create Product",
    description: `Creates a Salesforce Product2 record. Products represent items or services that can be added to Opportunities and Quotes via Opportunity Line Items. Use with sf_create_price_book to set pricing.

name: product name
productCode: optional SKU or product code
description: optional description
isActive: whether the product is available for use (default: true)
family: product family/category, e.g. 'Hardware'
quantityUnitOfMeasure: unit of measure, e.g. 'Each', 'Hour'`,
    inputSchema: CreateProductSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await createProduct(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_create_price_book", {
    title: "Create Price Book",
    description: `Creates a Pricebook2 record and optionally adds products with pricing via PricebookEntry records. Price books define the prices for your products. Each org has one standard price book; additional custom price books can be used for different customer segments or regions.

name: price book name
isActive: whether the price book is active
isStandard: true only for the standard price book
currencyIsoCode: ISO currency code (e.g. 'USD')
products: optional array of {productId, unitPrice, useStandardPrice?} to add to the price book`,
    inputSchema: CreatePriceBookSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await createPriceBook(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_create_entitlement_process", {
    title: "Create Entitlement Process",
    description: `Creates an Entitlement Process (SLA policy) that defines the time-based steps and milestones required to resolve cases. Entitlement processes automate service level agreement (SLA) enforcement.

fullName: entitlement process API name
name: display name
businessHoursName: optional business hours to apply
entryStartDateField: field that starts the SLA clock
milestones: array of milestone definitions to include`,
    inputSchema: CreateEntitlementProcessSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await createEntitlementProcess(auth, params);
    return resultContent(result);
  });

  server.registerTool("sf_create_milestone", {
    title: "Create Milestone Type",
    description: `Creates a Milestone Type that can be referenced in Entitlement Processes to define SLA checkpoints. Milestones represent required steps (e.g., 'First Response', 'Resolution') with time-based targets.

fullName: milestone type API name
name: display name
description: optional description
recurrenceType: how the milestone repeats — recursIndependently, recursChained, or noRecurrence`,
    inputSchema: CreateMilestoneSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    const auth = await getAuth();
    const result = await createMilestone(auth, params);
    return resultContent(result);
  });
}
