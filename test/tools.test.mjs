import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startMockMedusa, MOCK_KEY } from "./mock-medusa.mjs";

let mock, client;

before(async () => {
  mock = await startMockMedusa();
  client = new Client({ name: "test", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["dist/index.js", "stdio"],
      env: { ...process.env, MEDUSA_BACKEND_URL: mock.url, MEDUSA_API_KEY: MOCK_KEY, REPORT_TIMEZONE: "Europe/Prague" },
      stderr: "ignore",
    }),
  );
});
after(async () => {
  await client?.close();
  mock?.server.close();
});

async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content[0].text;
  return { isError: !!r.isError, text, data: r.isError ? undefined : JSON.parse(text) };
}
const lastRequest = (pred) => [...mock.log].reverse().find(pred);

test("registers all 16 tools with correct annotations", async () => {
  const { tools } = await client.listTools();
  assert.equal(tools.length, 16);
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.equal(byName.get_order.annotations.readOnlyHint, true);
  assert.equal(byName.cancel_order.annotations.destructiveHint, true);
});

test("sends Basic auth with the secret key", async () => {
  const r = await call("get_store_info");
  assert.equal(r.isError, false);
  assert.equal(r.data.stock_locations[0].id, "sloc_1");
});

test("date filters respect the reporting timezone (CEST = UTC+2)", async () => {
  await call("list_orders", { created_from: "2026-09-01", created_to: "2026-09-30" });
  const req = lastRequest((e) => e.p === "/admin/orders" && e.q.includes("created_at"));
  assert.match(req.q, /created_at\[\$gte\]=2026-08-31T22:00:00\.000Z/);
  assert.match(req.q, /created_at\[\$lte\]=2026-09-30T21:59:59\.999Z/);
});

test("get_order resolves an order number", async () => {
  const r = await call("get_order", { order: "#1001" });
  assert.equal(r.data.id, "order_1");
  assert.equal(r.data.items.length, 2);
});

test("get_order keeps Medusa's default fields (no plain field in `fields`)", async () => {
  const r = await call("get_order", { order: "order_1" });
  assert.equal(r.data.display_id, 1001);
  assert.equal(r.data.total, 1210);
  assert.equal(r.data.subtotal, 1000);
  assert.equal(r.data.email, "jan@example.com");
  assert.equal(r.data.currency, "czk");
  assert.equal(r.data.items[0].total, 800);
});

test("sales_report excludes canceled orders and orders outside the local day range", async () => {
  const r = await call("sales_report", { from: "2026-09-01", to: "2026-09-30", group_by: "day" });
  assert.equal(r.data.orders_considered, 1);
  assert.equal(r.data.totals.CZK.revenue, 1210); // the canceled order with a negative total is excluded
  assert.equal(r.data.totals.CZK.items_total, 1111);
  assert.equal(r.data.totals.EUR, undefined); // 2026-09-30T22:30Z is already October in Prague
  assert.equal(r.data.top_products[0].product_id, "prod_1");
});

test("list_inventory low stock filter", async () => {
  const r = await call("list_inventory", { low_stock_threshold: 2 });
  assert.deepEqual(r.data.items.map((i) => i.sku), ["NET-1"]);
});

test("create_fulfillment defaults to all remaining items and the only location", async () => {
  const r = await call("create_fulfillment", { order: "1001" });
  assert.equal(r.isError, false);
  const req = lastRequest((e) => e.p.endsWith("/fulfillments") && e.m === "POST");
  assert.deepEqual(req.b.items, [
    { id: "item_1", quantity: 2 },
    { id: "item_2", quantity: 1 },
  ]);
  assert.equal(req.b.location_id, "sloc_1");
});

test("create_shipment attaches tracking", async () => {
  const r = await call("create_shipment", { order: "order_1", tracking_number: "TRK1" });
  assert.equal(r.isError, false);
  const req = lastRequest((e) => e.p.endsWith("/shipments"));
  assert.equal(req.b.labels[0].tracking_number, "TRK1");
});

test("set_variant_price keeps prices with rules untouched", async () => {
  const r = await call("set_variant_price", {
    product_id: "prod_1",
    variant_id: "variant_1",
    currency_code: "CZK",
    amount: 449,
  });
  assert.equal(r.data.before, 400);
  const prices = mock.state.variant.prices;
  assert.equal(prices.find((p) => p.id === "price_czk").amount, 449);
  assert.equal(prices.find((p) => p.id === "price_czk_b2b").amount, 350);
  assert.deepEqual(prices.find((p) => p.id === "price_czk_b2b").rules, { customer_group_id: "cg_b2b" });
  assert.equal(prices.find((p) => p.id === "price_eur").amount, 17);
});

test("set_stock_level adjusts relatively and refuses negative stock", async () => {
  const ok = await call("set_stock_level", { sku: "BALL-1", adjust_by: 5 });
  assert.equal(ok.data.stocked_after, ok.data.stocked_before + 5);
  const bad = await call("set_stock_level", { sku: "BALL-1", adjust_by: -1000 });
  assert.equal(bad.isError, true);
  const untracked = await call("set_stock_level", { sku: "NO-INVENTORY", adjust_by: 1 });
  assert.equal(untracked.isError, true);
  assert.match(untracked.text, /manage_inventory/);
});

test("read-only mode hides write tools", async () => {
  const ro = new Client({ name: "ro", version: "1" });
  await ro.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["dist/index.js", "stdio"],
      env: { ...process.env, MEDUSA_BACKEND_URL: mock.url, MEDUSA_API_KEY: MOCK_KEY, MEDUSA_READ_ONLY: "true" },
      stderr: "ignore",
    }),
  );
  const { tools } = await ro.listTools();
  await ro.close();
  assert.equal(tools.length, 9);
  assert.ok(tools.every((t) => t.annotations.readOnlyHint));
});

test("customers and products", async () => {
  const c = await call("get_customer", { customer_id: "cus_1" });
  assert.equal(c.data.stats.orders, 2); // order_1 + order_3, canceled order_2 belongs to cus_2
  assert.deepEqual(c.data.stats.total_spent, { CZK: 1210, EUR: 50 });
  assert.equal((await call("list_customers", { q: "jan" })).data.customers.length, 1);
  assert.equal((await call("list_products")).data.products[0].variants[0].sku, "BALL-1");
  const p = await call("get_product", { product_id: "prod_1" });
  assert.deepEqual(p.data.variants[0].inventory_item_ids, ["iitem_1"]);
});

test("refuses a publishable key with a clear message", async () => {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(process.execPath, ["dist/index.js", "stdio"], {
    env: { ...process.env, MEDUSA_BACKEND_URL: mock.url, MEDUSA_API_KEY: "pk_0123456789abcdef" },
    input: "",
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /publishable key/);
});
