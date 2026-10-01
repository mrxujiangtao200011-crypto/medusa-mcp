#!/usr/bin/env node
// Read-only smoke test against a real Medusa v2 backend.
// Usage: MEDUSA_BACKEND_URL=https://api.example.com MEDUSA_API_KEY=sk_... node scripts/smoke.mjs
// Runs the server over stdio with MEDUSA_READ_ONLY=true and calls every read tool.
// Output contains only shapes (keys, counts, types) — no customer data — so it is safe to share.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
for (const v of ["MEDUSA_BACKEND_URL", "MEDUSA_API_KEY"]) {
  if (!process.env[v]) {
    console.error(`Missing ${v}`);
    process.exit(1);
  }
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, "dist/index.js"), "stdio"],
  env: { ...process.env, MEDUSA_READ_ONLY: "true" },
  stderr: "pipe",
});
const client = new Client({ name: "smoke", version: "1" });
await client.connect(transport);

/** Replace values with their types so the output carries no personal data. */
function shape(v, depth = 0) {
  if (Array.isArray(v)) return v.length ? [`${v.length}×`, shape(v[0], depth + 1)] : [];
  if (v && typeof v === "object") {
    if (depth > 4) return "{…}";
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x, depth + 1)]));
  }
  return v === null ? "null" : typeof v;
}

const results = [];
/** Medusa silently drops fields it does not return, so a call can succeed with half the data – check key fields. */
const EXPECT = {
  get_order: ["display_id", "created_at", "status", "email", "total", "subtotal", "currency", "items"],
  get_product: ["title", "status", "variants"],
  sales_report: ["orders_considered", "totals"],
};

async function run(name, args = {}) {
  const t = Date.now();
  try {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? "";
    const ms = Date.now() - t;
    if (r.isError) {
      results.push({ name, ok: false, ms });
      console.log(`\n✗ ${name} (${ms} ms)\n${text.replace(/sk_[A-Za-z0-9_]+/g, "sk_***").slice(0, 2000)}`);
      return null;
    }
    const data = JSON.parse(text);
    const missing = (EXPECT[name] ?? []).filter((k) => data[k] === undefined);
    results.push({ name, ok: !missing.length, ms });
    const mark = missing.length ? `✗ ${name} – missing fields: ${missing.join(", ")}` : `✓ ${name}`;
    console.log(`\n${mark} (${ms} ms)\n${JSON.stringify(shape(data))}`);
    return data;
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t });
    console.log(`\n✗ ${name}: ${e.message}`);
    return null;
  }
}

const today = new Date();
const monthAgo = new Date(today.getTime() - 30 * 86400000);
const ymd = (d) => d.toISOString().slice(0, 10);

await run("get_store_info");
const orders = await run("list_orders", { limit: 5 });
await run("list_orders", { created_from: ymd(monthAgo), created_to: ymd(today), limit: 5 });
await run("list_orders", { fulfillment_status: ["not_fulfilled"], limit: 5 });
const firstOrder = orders?.orders?.[0];
if (firstOrder) {
  await run("get_order", { order: firstOrder.id });
  if (firstOrder.display_id) await run("get_order", { order: String(firstOrder.display_id) });
}
const customers = await run("list_customers", { limit: 5 });
if (customers?.customers?.[0]) await run("get_customer", { customer_id: customers.customers[0].id });
const products = await run("list_products", { limit: 5 });
if (products?.products?.[0]) await run("get_product", { product_id: products.products[0].id });
await run("list_inventory", { limit: 5 });
await run("list_inventory", { low_stock_threshold: 3, limit: 5 });
await run("sales_report", { from: ymd(monthAgo), to: ymd(today), group_by: "week" });

await client.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} OK${failed.length ? ` — failed: ${failed.map((f) => f.name).join(", ")}` : ""}`);
process.exit(failed.length ? 1 : 0);
