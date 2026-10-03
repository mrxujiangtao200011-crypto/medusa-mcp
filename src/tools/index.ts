import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MedusaClient } from "../medusa.js";
import type { MedusaConfig } from "../config.js";
import { createContext } from "./helpers.js";
import { registerStoreTools } from "./store.js";
import { registerOrderTools } from "./orders.js";
import { registerCustomerTools } from "./customers.js";
import { registerProductTools } from "./products.js";
import { registerCatalogTools } from "./catalog.js";
import { registerInventoryTools } from "./inventory.js";
import { registerPricingTools } from "./pricing.js";
import { registerPromotionTools } from "./promotions.js";
import { registerReportTools } from "./reports.js";
import { registerRawTool } from "./raw.js";

/** Each module registers its read tools and, unless the server is read-only, its write tools. */
export function registerTools(server: McpServer, medusa: MedusaClient, cfg: MedusaConfig) {
  const ctx = createContext(server, medusa, cfg);
  registerStoreTools(ctx);
  registerOrderTools(ctx);
  registerCustomerTools(ctx);
  registerProductTools(ctx);
  registerCatalogTools(ctx);
  registerInventoryTools(ctx);
  registerPricingTools(ctx);
  registerPromotionTools(ctx);
  registerReportTools(ctx);
  registerRawTool(ctx);
}
