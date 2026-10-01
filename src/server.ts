import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MedusaConfig } from "./config.js";
import type { MedusaClient } from "./medusa.js";
import { registerTools } from "./tools.js";

export function createServer(medusa: MedusaClient, cfg: MedusaConfig): McpServer {
  const server = new McpServer(
    { name: "medusa-mcp", version: "0.2.1" },
    {
      instructions:
        "Tools for managing a Medusa v2 store. Amounts are in major currency units (49.99 = 49.99 EUR). " +
        "Plain dates are interpreted in the store's reporting timezone. Ask the user for explicit confirmation before canceling orders or making bulk changes." +
        (cfg.readOnly ? " The server is running in read-only mode." : ""),
    },
  );
  registerTools(server, medusa, cfg);
  return server;
}
