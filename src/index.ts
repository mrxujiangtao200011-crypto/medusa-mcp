#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadMedusaConfig } from "./config.js";
import { MedusaClient } from "./medusa.js";
import { createServer } from "./server.js";
import { startHttp } from "./http.js";

const mode = (process.argv[2] ?? process.env.MCP_TRANSPORT ?? "stdio").toLowerCase();

if (mode === "http") {
  await startHttp();
} else if (mode === "stdio") {
  const cfg = loadMedusaConfig();
  const server = createServer(new MedusaClient(cfg), cfg);
  await server.connect(new StdioServerTransport());
  console.error(`[medusa-mcp] stdio ready${cfg.readOnly ? " (read-only)" : ""}`);
} else {
  console.error(`Unknown mode "${mode}". Usage: medusa-mcp stdio | medusa-mcp http`);
  process.exit(1);
}
