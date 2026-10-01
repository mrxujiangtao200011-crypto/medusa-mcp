// Minimal mock of the Medusa v2 Admin API used by the test suite.
import http from "node:http";

export const MOCK_KEY = "sk_test_123";

export function startMockMedusa(port = 0) {

const KEY = MOCK_KEY;
const log = [];
const state = {
  orders: [
    {
      id: "order_1", display_id: 1001, status: "pending", payment_status: "captured", fulfillment_status: "not_fulfilled",
      email: "jan@example.com", currency_code: "czk", total: 1210, item_total: 1111, subtotal: 1000, shipping_total: 99, tax_total: 210, discount_total: 0,
      created_at: "2026-09-10T08:00:00Z", customer_id: "cus_1", customer: { first_name: "Jan", last_name: "Novák" },
      shipping_address: { city: "Prague", country_code: "cz" },
      items: [{ id: "item_1", quantity: 2, title: "Ball", product_title: "Roundnet ball", product_id: "prod_1", variant_sku: "BALL-1", total: 800, unit_price: 400, detail: { fulfilled_quantity: 0, shipped_quantity: 0 } },
              { id: "item_2", quantity: 1, title: "Net", product_title: "Net", product_id: "prod_2", variant_sku: "NET-1", total: 410, unit_price: 410, detail: { fulfilled_quantity: 0 } }],
      fulfillments: [],
    },
    {
      id: "order_2", display_id: 1002, status: "canceled", payment_status: "refunded", fulfillment_status: "not_fulfilled",
      email: "x@example.com", currency_code: "czk", total: -500, created_at: "2026-09-11T22:30:00Z", customer_id: "cus_2",
      items: [{ id: "i3", quantity: 1, product_id: "prod_1", total: 500 }],
    },
    {
      id: "order_3", display_id: 1003, status: "completed", payment_status: "captured", fulfillment_status: "shipped",
      email: "jan@example.com", currency_code: "eur", total: 50, created_at: "2026-09-30T22:30:00Z", customer_id: "cus_1",
      items: [{ id: "i4", quantity: 3, product_id: "prod_1", product_title: "Roundnet ball", total: 50 }],
    },
  ],
  variant: { id: "variant_1", title: "Default", sku: "BALL-1", prices: [
    { id: "price_czk", currency_code: "czk", amount: 400, rules: {} },
    { id: "price_eur", currency_code: "eur", amount: 17, rules: {} },
    { id: "price_czk_b2b", currency_code: "czk", amount: 350, rules: { customer_group_id: "cg_b2b" } },
  ]},
  inv: [
    { id: "iitem_1", sku: "BALL-1", title: "Ball", location_levels: [{ location_id: "sloc_1", stocked_quantity: 10, reserved_quantity: 2, available_quantity: 8 }] },
    { id: "iitem_2", sku: "NET-1", title: "Net", location_levels: [{ location_id: "sloc_1", stocked_quantity: 1, reserved_quantity: 1, available_quantity: 0 }] },
    { id: "iitem_del", sku: "DEL-1", title: "Test product", reserved_quantity: 0, location_levels: [{ location_id: "sloc_1", stocked_quantity: 5, reserved_quantity: 0, available_quantity: 5 }] },
  ],
};

function send(res, code, obj) { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); }

// Mirrors Medusa's prepareListQuery: one plain field (no +, -, * prefix and no .* suffix) replaces the
// default fields entirely, so only id, the listed fields and the listed relations come back.
function selectFields(obj, fields) {
  if (!obj || fields == null) return obj;
  const list = fields.split(",").filter(Boolean);
  const replaces = !list.length || list.some((f) => !/^[+\- *]/.test(f) && !f.endsWith(".*"));
  if (!replaces) return obj;
  const keep = new Set(["id", ...list.map((f) => f.replace(/^[+ *-]/, "").replace(/\.\*$/, "").split(".")[0])]);
  return Object.fromEntries(Object.entries(obj).filter(([k]) => keep.has(k)));
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  let body = ""; for await (const c of req) body += c;
  log.push({ m: req.method, p: u.pathname, q: decodeURIComponent(u.search), b: body ? JSON.parse(body) : undefined });
  if (u.pathname === "/__log") return send(res, 200, log);
  const expected = "Basic " + Buffer.from(KEY + ":").toString("base64");
  if (req.headers.authorization !== expected) return send(res, 401, { message: "Unauthorized" });
  const p = u.pathname;
  if (p === "/admin/orders" && req.method === "GET") {
    let o = state.orders;
    const gte = u.searchParams.get("created_at[$gte]"), lte = u.searchParams.get("created_at[$lte]");
    if (gte) o = o.filter(x => x.created_at >= gte);
    if (lte) o = o.filter(x => x.created_at <= lte);
    const q = u.searchParams.get("q"); if (q) o = o.filter(x => String(x.display_id).includes(q) || x.email.includes(q));
    const cid = u.searchParams.get("customer_id"); if (cid) o = o.filter(x => x.customer_id === cid);
    const off = +(u.searchParams.get("offset") ?? 0), lim = +(u.searchParams.get("limit") ?? 50);
    const f = u.searchParams.get("fields");
    return send(res, 200, { orders: o.slice(off, off + lim).map((x) => selectFields(x, f)), count: o.length, offset: off, limit: lim });
  }
  let m;
  if ((m = p.match(/^\/admin\/orders\/([^/]+)$/)))
    return send(res, 200, { order: selectFields(state.orders.find(o => o.id === m[1]), u.searchParams.get("fields")) });
  if ((m = p.match(/^\/admin\/orders\/([^/]+)\/fulfillments$/))) {
    const o = state.orders.find(o => o.id === m[1]);
    o.fulfillments.push({ id: "ful_1", shipped_at: null, items: JSON.parse(body).items.map(i => ({ line_item_id: i.id, quantity: i.quantity })) });
    o.fulfillment_status = "fulfilled"; return send(res, 200, { order: o });
  }
  if ((m = p.match(/^\/admin\/orders\/([^/]+)\/fulfillments\/([^/]+)\/shipments$/))) {
    const o = state.orders.find(o => o.id === m[1]); o.fulfillment_status = "shipped"; return send(res, 200, { order: o });
  }
  if ((m = p.match(/^\/admin\/orders\/([^/]+)\/cancel$/))) return send(res, 200, { order: { status: "canceled" } });
  if (p === "/admin/customers") return send(res, 200, { customers: [{ id: "cus_1", email: "jan@example.com", first_name: "Jan", last_name: "Novák", has_account: true }], count: 1, offset: 0 });
  if (p === "/admin/customers/cus_1") return send(res, 200, { customer: { id: "cus_1", email: "jan@example.com", addresses: [], groups: [] } });
  if (p === "/admin/products") return send(res, 200, { products: [{ id: "prod_1", title: "Roundnet ball", handle: "ball", status: "published", variants: [{ id: "variant_1", title: "Default", sku: "BALL-1" }] }], count: 1, offset: 0 });
  if (p === "/admin/products/prod_1") return send(res, 200, { product: { id: "prod_1", title: "Roundnet ball", status: "published", variants: [{ ...state.variant, inventory_items: [{ inventory_item_id: "iitem_1" }] }] } });
  if (p === "/admin/products/prod_del") {
    if (req.method === "DELETE") { state.productDeleted = true; return send(res, 200, { id: "prod_del", object: "product", deleted: true }); }
    if (state.productDeleted) return send(res, 404, { message: "Product with id: prod_del was not found" });
    return send(res, 200, { product: { id: "prod_del", title: "Test product", handle: "test-product", status: "draft",
      variants: [{ id: "variant_del", sku: "DEL-1", inventory_items: [{ inventory_item_id: "iitem_del" }] }] } });
  }
  if ((m = p.match(/^\/admin\/inventory-items\/([^/]+)$/))) {
    const i = state.inv.findIndex(x => x.id === m[1]);
    if (i < 0) return send(res, 404, { message: "Inventory item not found" });
    if (req.method === "DELETE") { state.inv.splice(i, 1); return send(res, 200, { id: m[1], deleted: true }); }
    return send(res, 200, { inventory_item: state.inv[i] });
  }
  if (p === "/admin/stock-locations") return send(res, 200, { stock_locations: [{ id: "sloc_1", name: "Main warehouse", address: { city: "Main warehouse", country_code: "cz" } }], count: 1 });
  if (p === "/admin/regions") return send(res, 200, { regions: [{ id: "reg_1", name: "Czechia", currency_code: "czk", countries: [{ iso_2: "cz" }] }] });
  if (p === "/admin/sales-channels") return send(res, 200, { sales_channels: [{ id: "sc_1", name: "Web" }] });
  if (p === "/admin/products/prod_1/variants/variant_1") {
    if (req.method === "POST") { state.variant.prices = JSON.parse(body).prices; return send(res, 200, { product: {} }); }
    return send(res, 200, { variant: state.variant });
  }
  if (p === "/admin/inventory-items") {
    let it = state.inv; const sku = u.searchParams.get("sku"); if (sku) it = it.filter(i => i.sku === sku);
    const off = +(u.searchParams.get("offset") ?? 0), lim = +(u.searchParams.get("limit") ?? 50);
    return send(res, 200, { inventory_items: it.slice(off, off + lim), count: it.length, offset: off });
  }
  if ((m = p.match(/^\/admin\/inventory-items\/([^/]+)\/location-levels\/([^/]+)$/))) {
    const it = state.inv.find(i => i.id === m[1]); it.location_levels[0].stocked_quantity = JSON.parse(body).stocked_quantity;
    return send(res, 200, { inventory_item: it });
  }
  send(res, 404, { message: "not mocked: " + p });
});
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, log, state, url: `http://127.0.0.1:${server.address().port}` })));
}

