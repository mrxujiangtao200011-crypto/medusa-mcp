import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { MedusaClient, MedusaError } from "./medusa.js";
import type { MedusaConfig } from "./config.js";

// ---------- helpers ----------

const MAX_OUTPUT = 80_000;

function ok(data: unknown): CallToolResult {
  let text = JSON.stringify(data);
  if (text.length > MAX_OUTPUT) {
    text = text.slice(0, MAX_OUTPUT) + "\n…(output truncated – narrow the filter or lower the limit)";
  }
  return { content: [{ type: "text", text }] };
}

function fail(e: unknown): CallToolResult {
  const msg =
    e instanceof MedusaError
      ? `${e.message}${e.body && typeof e.body === "object" ? `\n${JSON.stringify(e.body)}` : ""}`
      : e instanceof Error
        ? e.message
        : String(e);
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}

function wrap<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return ok(await fn(args));
    } catch (e) {
      return fail(e);
    }
  };
}

const DEFAULT_TZ = process.env.REPORT_TIMEZONE || "UTC";

/** Timezone offset (ms) at a given instant. */
function tzOffsetMs(tz: string, instant: number): number {
  // Intl only resolves to whole seconds – work on a whole-second instant so ms don't leak into the offset
  const at = Math.floor(instant / 1000) * 1000;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(at));
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  return asUtc - at;
}

/** "2026-09-01" in a timezone -> UTC ISO of the start (or end) of that day. Full ISO timestamps pass through. */
function zonedBoundary(input: string, tz: string, endOfDay: boolean): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim());
  if (!m) {
    const d = new Date(input);
    if (isNaN(d.getTime())) throw new Error(`Invalid date: ${input}`);
    return d.toISOString();
  }
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const naive = endOfDay ? Date.UTC(y, mo, d, 23, 59, 59, 999) : Date.UTC(y, mo, d, 0, 0, 0, 0);
  const off = tzOffsetMs(tz, naive);
  return new Date(naive - off).toISOString();
}

function localDate(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(iso),
  );
}

function isoWeekKey(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function dateFilter(from?: string, to?: string, tz = DEFAULT_TZ) {
  if (!from && !to) return undefined;
  const f: Record<string, string> = {};
  if (from) f.$gte = zonedBoundary(from, tz, false);
  if (to) f.$lte = zonedBoundary(to, tz, true);
  return f;
}

function summarizeOrder(o: any) {
  const name = [o.customer?.first_name, o.customer?.last_name].filter(Boolean).join(" ") || undefined;
  return {
    id: o.id,
    display_id: o.display_id,
    created_at: o.created_at,
    status: o.status,
    payment_status: o.payment_status,
    fulfillment_status: o.fulfillment_status,
    email: o.email,
    customer: name,
    total: o.total,
    currency: o.currency_code,
    items: Array.isArray(o.items) ? o.items.reduce((s: number, i: any) => s + Number(i.quantity ?? 0), 0) : undefined,
    ship_to: o.shipping_address
      ? [o.shipping_address.city, o.shipping_address.country_code?.toUpperCase()].filter(Boolean).join(", ")
      : undefined,
  };
}

const ORDER_LIST_FIELDS =
  "id,display_id,status,payment_status,fulfillment_status,email,total,currency_code,created_at," +
  "customer.first_name,customer.last_name,shipping_address.city,shipping_address.country_code,items.quantity";

const PAYMENT_STATUSES = [
  "not_paid",
  "awaiting",
  "authorized",
  "partially_authorized",
  "captured",
  "partially_captured",
  "partially_refunded",
  "refunded",
  "canceled",
  "requires_action",
] as const;
const FULFILLMENT_STATUSES = [
  "not_fulfilled",
  "partially_fulfilled",
  "fulfilled",
  "partially_shipped",
  "shipped",
  "partially_delivered",
  "delivered",
  "canceled",
] as const;

const limitSchema = z.number().int().min(1).max(200).default(20).describe("Number of records (max 200)");
const offsetSchema = z.number().int().min(0).default(0).describe("Records to skip (pagination)");

// ---------- registration ----------

export function registerTools(server: McpServer, medusa: MedusaClient, cfg: MedusaConfig) {
  const RO = { readOnlyHint: true, openWorldHint: false } as const;

  /** Resolves an order by ID (order_…) or by order number (display_id). */
  async function resolveOrderId(ref: string): Promise<string> {
    const r = ref.trim().replace(/^#/, "");
    if (r.startsWith("order_")) return r;
    if (/^\d+$/.test(r)) {
      const res = await medusa.get("/admin/orders", { q: r, fields: "id,display_id", limit: 50 });
      const hit = (res.orders ?? []).find((o: any) => String(o.display_id) === r);
      if (hit) return hit.id;
      throw new Error(`Order #${r} not found`);
    }
    return r;
  }

  async function getStockLocations() {
    const res = await medusa.get("/admin/stock-locations", { fields: "id,name,*address", limit: 100 });
    return (res.stock_locations ?? []) as any[];
  }

  // ===== Store overview =====
  server.registerTool(
    "get_store_info",
    {
      title: "Store overview",
      description:
        "Returns regions (currencies), sales channels and stock locations. A good first call to learn location IDs and currencies.",
      inputSchema: {},
      annotations: RO,
    },
    wrap(async () => {
      const [regions, channels, locations] = await Promise.all([
        medusa.get("/admin/regions", { fields: "id,name,currency_code,*countries", limit: 100 }),
        medusa.get("/admin/sales-channels", { fields: "id,name,is_disabled", limit: 100 }),
        getStockLocations(),
      ]);
      return {
        regions: (regions.regions ?? []).map((r: any) => ({
          id: r.id,
          name: r.name,
          currency: r.currency_code,
          countries: (r.countries ?? []).map((c: any) => c.iso_2),
        })),
        sales_channels: channels.sales_channels ?? [],
        stock_locations: locations.map((l) => ({
          id: l.id,
          name: l.name,
          city: l.address?.city,
          country: l.address?.country_code,
        })),
        read_only: cfg.readOnly,
      };
    }),
  );

  // ===== Orders =====
  server.registerTool(
    "list_orders",
    {
      title: "List orders",
      description:
        "Lists orders, newest first. Filters: full-text, date range (YYYY-MM-DD in the reporting timezone), customer, order/payment/fulfillment status.",
      inputSchema: {
        q: z.string().optional().describe("Full-text search – order number, email, name…"),
        created_from: z.string().optional().describe("From date, e.g. 2026-09-01"),
        created_to: z.string().optional().describe("To date (inclusive), e.g. 2026-09-30"),
        customer_id: z.string().optional(),
        status: z
          .array(z.enum(["pending", "completed", "draft", "archived", "canceled", "requires_action"]))
          .optional()
          .describe("Order status"),
        payment_status: z.array(z.enum(PAYMENT_STATUSES)).optional(),
        fulfillment_status: z
          .array(z.enum(FULFILLMENT_STATUSES))
          .optional()
          .describe("E.g. ['not_fulfilled'] = waiting to be fulfilled"),
        limit: limitSchema,
        offset: offsetSchema,
      },
      annotations: RO,
    },
    wrap(async (a) => {
      const query: Record<string, any> = {
        fields: ORDER_LIST_FIELDS,
        order: "-created_at",
        q: a.q,
        customer_id: a.customer_id,
        status: a.status,
        created_at: dateFilter(a.created_from, a.created_to),
      };
      // payment/fulfillment status are not API filters -> filter client-side
      if (a.payment_status?.length || a.fulfillment_status?.length) {
        const all = await medusa.listAll("/admin/orders", "orders", query, 3000);
        const filtered = all.items.filter(
          (o: any) =>
            (!a.payment_status?.length || a.payment_status.includes(o.payment_status)) &&
            (!a.fulfillment_status?.length || a.fulfillment_status.includes(o.fulfillment_status)),
        );
        return {
          count: filtered.length,
          offset: a.offset,
          scanned: all.items.length,
          scan_truncated: all.truncated || undefined,
          orders: filtered.slice(a.offset, a.offset + a.limit).map(summarizeOrder),
        };
      }
      const res = await medusa.get("/admin/orders", { ...query, limit: a.limit, offset: a.offset });
      return { count: res.count, offset: res.offset, orders: (res.orders ?? []).map(summarizeOrder) };
    }),
  );

  server.registerTool(
    "get_order",
    {
      title: "Get order",
      description:
        "Full order detail – line items, addresses, payments, fulfillments and tracking numbers. Accepts an order ID (order_…) or the order number.",
      inputSchema: { order: z.string().describe("Order ID (order_…) or order number, e.g. 1042") },
      annotations: RO,
    },
    wrap(async (a) => {
      const id = await resolveOrderId(a.order);
      // Every field is prefixed with + or *: a single plain field would make Medusa drop its defaults
      // (display_id, totals, email, currency_code…).
      const res = await medusa.get(`/admin/orders/${id}`, {
        fields:
          "+summary,+email,+currency_code,+metadata,*items,*items.detail,*shipping_address,*billing_address," +
          "*customer,*shipping_methods,*fulfillments,*fulfillments.items,*fulfillments.labels,*payment_collections",
      });
      const o = res.order;
      return {
        ...summarizeOrder(o),
        subtotal: o.subtotal,
        shipping_total: o.shipping_total,
        tax_total: o.tax_total,
        discount_total: o.discount_total,
        summary: o.summary,
        items: (o.items ?? []).map((i: any) => ({
          id: i.id,
          title: i.product_title ?? i.title,
          variant: i.variant_title,
          sku: i.variant_sku,
          quantity: i.quantity,
          unit_price: i.unit_price,
          total: i.total,
          fulfilled: i.detail?.fulfilled_quantity,
          shipped: i.detail?.shipped_quantity,
        })),
        shipping_address: o.shipping_address,
        billing_address: o.billing_address,
        shipping_methods: (o.shipping_methods ?? []).map((m: any) => ({ name: m.name, amount: m.amount })),
        fulfillments: (o.fulfillments ?? []).map((f: any) => ({
          id: f.id,
          location_id: f.location_id,
          created_at: f.created_at,
          shipped_at: f.shipped_at,
          delivered_at: f.delivered_at,
          canceled_at: f.canceled_at,
          items: (f.items ?? []).map((i: any) => ({ line_item_id: i.line_item_id, quantity: i.quantity, title: i.title })),
          tracking: (f.labels ?? []).map((l: any) => ({ number: l.tracking_number, url: l.tracking_url })),
        })),
        payments: (o.payment_collections ?? []).map((p: any) => ({
          id: p.id,
          status: p.status,
          amount: p.amount,
          captured: p.captured_amount,
          refunded: p.refunded_amount,
        })),
        metadata: o.metadata,
      };
    }),
  );

  // ===== Customers =====
  server.registerTool(
    "list_customers",
    {
      title: "List customers",
      description: "Searches customers by name, email or company.",
      inputSchema: {
        q: z.string().optional().describe("Full-text search – name, email, company"),
        email: z.string().optional(),
        has_account: z.boolean().optional().describe("true = registered, false = guests"),
        limit: limitSchema,
        offset: offsetSchema,
      },
      annotations: RO,
    },
    wrap(async (a) => {
      const res = await medusa.get("/admin/customers", {
        fields: "id,email,first_name,last_name,company_name,phone,has_account,created_at",
        order: "-created_at",
        q: a.q,
        email: a.email,
        has_account: a.has_account,
        limit: a.limit,
        offset: a.offset,
      });
      return { count: res.count, offset: res.offset, customers: res.customers ?? [] };
    }),
  );

  server.registerTool(
    "get_customer",
    {
      title: "Get customer",
      description: "Customer detail with addresses, groups and order history (count, total spent, recent orders).",
      inputSchema: { customer_id: z.string().describe("Customer ID (cus_…)") },
      annotations: RO,
    },
    wrap(async (a) => {
      const [c, orders] = await Promise.all([
        medusa.get(`/admin/customers/${a.customer_id}`, { fields: "*addresses,*groups" }),
        medusa.listAll(
          "/admin/orders",
          "orders",
          { customer_id: a.customer_id, fields: ORDER_LIST_FIELDS, order: "-created_at" },
          1000,
        ),
      ]);
      const valid = orders.items.filter((o: any) => o.status !== "canceled" && o.status !== "draft");
      const spent: Record<string, number> = {};
      for (const o of valid) {
        const cur = (o.currency_code ?? "?").toUpperCase();
        spent[cur] = round2((spent[cur] ?? 0) + Number(o.total ?? 0));
      }
      return {
        customer: c.customer,
        stats: {
          orders: valid.length,
          canceled: orders.items.length - valid.length,
          total_spent: spent,
          first_order: valid.at(-1)?.created_at,
          last_order: valid[0]?.created_at,
        },
        recent_orders: orders.items.slice(0, 10).map(summarizeOrder),
      };
    }),
  );

  // ===== Products =====
  server.registerTool(
    "list_products",
    {
      title: "List products",
      description: "Lists products with their variants (SKUs). Filter by full-text, status, collection or category.",
      inputSchema: {
        q: z.string().optional(),
        status: z.array(z.enum(["draft", "proposed", "published", "rejected"])).optional(),
        collection_id: z.string().optional(),
        category_id: z.string().optional(),
        limit: limitSchema,
        offset: offsetSchema,
      },
      annotations: RO,
    },
    wrap(async (a) => {
      const res = await medusa.get("/admin/products", {
        fields: "id,title,handle,status,created_at,updated_at,variants.id,variants.title,variants.sku",
        order: "-updated_at",
        q: a.q,
        status: a.status,
        collection_id: a.collection_id ? [a.collection_id] : undefined,
        category_id: a.category_id ? [a.category_id] : undefined,
        limit: a.limit,
        offset: a.offset,
      });
      return {
        count: res.count,
        offset: res.offset,
        products: (res.products ?? []).map((p: any) => ({
          id: p.id,
          title: p.title,
          handle: p.handle,
          status: p.status,
          updated_at: p.updated_at,
          variants: (p.variants ?? []).map((v: any) => ({ id: v.id, title: v.title, sku: v.sku })),
        })),
      };
    }),
  );

  server.registerTool(
    "get_product",
    {
      title: "Get product",
      description: "Product detail – variants, prices in all currencies, linked inventory items, categories, collection, tags.",
      inputSchema: { product_id: z.string().describe("Product ID (prod_…)") },
      annotations: RO,
    },
    wrap(async (a) => {
      let res: any;
      try {
        res = await medusa.get(`/admin/products/${a.product_id}`, {
          fields: "*variants,*variants.prices,*variants.inventory_items,*options,*categories,*collection,*tags,*images",
        });
      } catch (e) {
        if (!(e instanceof MedusaError) || e.status !== 400) throw e;
        res = await medusa.get(`/admin/products/${a.product_id}`, { fields: "*variants,*variants.prices" });
      }
      const p = res.product;
      return {
        id: p.id,
        title: p.title,
        subtitle: p.subtitle,
        handle: p.handle,
        status: p.status,
        description: p.description,
        collection: p.collection?.title,
        categories: (p.categories ?? []).map((c: any) => c.name),
        tags: (p.tags ?? []).map((t: any) => t.value),
        thumbnail: p.thumbnail,
        images: (p.images ?? []).length || undefined,
        options: (p.options ?? []).map((o: any) => ({ title: o.title, values: (o.values ?? []).map((v: any) => v.value) })),
        variants: (p.variants ?? []).map((v: any) => ({
          id: v.id,
          title: v.title,
          sku: v.sku,
          manage_inventory: v.manage_inventory,
          allow_backorder: v.allow_backorder,
          prices: (v.prices ?? []).map((pr: any) => ({
            currency: pr.currency_code,
            amount: pr.amount,
            rules: pr.rules && Object.keys(pr.rules).length ? pr.rules : undefined,
            min_quantity: pr.min_quantity ?? undefined,
          })),
          inventory_item_ids: (v.inventory_items ?? []).map((i: any) => i.inventory_item_id),
        })),
        metadata: p.metadata,
        updated_at: p.updated_at,
      };
    }),
  );

  // ===== Inventory =====
  server.registerTool(
    "list_inventory",
    {
      title: "Inventory levels",
      description:
        "Inventory items with stock per location (stocked, reserved, available). With low_stock_threshold returns only items at or below the threshold.",
      inputSchema: {
        q: z.string().optional().describe("Full-text search – title, SKU"),
        sku: z.string().optional().describe("Exact SKU"),
        location_id: z.string().optional().describe("Only this stock location"),
        low_stock_threshold: z
          .number()
          .int()
          .optional()
          .describe("Only return items whose available quantity is less than or equal to this value"),
        limit: limitSchema,
        offset: offsetSchema,
      },
      annotations: RO,
    },
    wrap(async (a) => {
      const base = { fields: "id,sku,title,*location_levels", q: a.q, sku: a.sku, order: "sku" };
      const shape = (it: any) => {
        const levels = (it.location_levels ?? [])
          .filter((l: any) => !a.location_id || l.location_id === a.location_id)
          .map((l: any) => ({
            location_id: l.location_id,
            stocked: l.stocked_quantity,
            reserved: l.reserved_quantity,
            available: l.available_quantity ?? Number(l.stocked_quantity ?? 0) - Number(l.reserved_quantity ?? 0),
            incoming: l.incoming_quantity || undefined,
          }));
        return {
          id: it.id,
          sku: it.sku,
          title: it.title,
          available_total: levels.reduce((s: number, l: any) => s + Number(l.available ?? 0), 0),
          levels,
        };
      };
      if (a.low_stock_threshold !== undefined) {
        const all = await medusa.listAll("/admin/inventory-items", "inventory_items", base, 5000);
        const low = all.items
          .map(shape)
          .filter((i) => i.available_total <= a.low_stock_threshold!)
          .sort((x, y) => x.available_total - y.available_total);
        return {
          count: low.length,
          scanned: all.items.length,
          items: low.slice(a.offset, a.offset + a.limit),
        };
      }
      const res = await medusa.get("/admin/inventory-items", { ...base, limit: a.limit, offset: a.offset });
      return { count: res.count, offset: res.offset, items: (res.inventory_items ?? []).map(shape) };
    }),
  );

  // ===== Reports =====
  server.registerTool(
    "sales_report",
    {
      title: "Sales report",
      description:
        "Computes sales for a period: order count, revenue, average order value, units sold, unique customers, " +
        "a time series (day/week/month) and top products. Amounts are per currency. Canceled and draft orders are excluded.",
      inputSchema: {
        from: z.string().describe("From date, e.g. 2026-09-01"),
        to: z.string().describe("To date (inclusive), e.g. 2026-09-30"),
        group_by: z.enum(["day", "week", "month", "none"]).default("day"),
        top_n: z.number().int().min(0).max(50).default(10).describe("How many top products to return"),
        only_paid: z
          .boolean()
          .default(false)
          .describe("Only count paid orders (captured / partially_refunded / partially_captured)"),
        timezone: z.string().default(DEFAULT_TZ).describe("IANA timezone used for date boundaries and buckets"),
      },
      annotations: RO,
    },
    wrap(async (a) => {
      const res = await medusa.listAll(
        "/admin/orders",
        "orders",
        {
          fields:
            "id,display_id,status,payment_status,currency_code,total,subtotal,item_total,shipping_total,tax_total,discount_total," +
            "created_at,customer_id,email,items.product_id,items.product_title,items.title,items.variant_sku,items.quantity,items.total",
          created_at: dateFilter(a.from, a.to, a.timezone),
          order: "created_at",
        },
        20000,
      );
      const PAID = new Set(["captured", "partially_refunded", "partially_captured"]);
      const orders = res.items.filter(
        (o: any) => !["canceled", "draft"].includes(o.status) && (!a.only_paid || PAID.has(o.payment_status)),
      );

      type Agg = {
        orders: number;
        revenue: number;
        items_total: number;
        subtotal: number;
        shipping: number;
        tax: number;
        discounts: number;
        items_sold: number;
        customers: Set<string>;
      };
      const newAgg = (): Agg => ({
        orders: 0,
        revenue: 0,
        items_total: 0,
        subtotal: 0,
        shipping: 0,
        tax: 0,
        discounts: 0,
        items_sold: 0,
        customers: new Set(),
      });
      const byCur: Record<string, Agg> = {};
      const series: Record<string, Record<string, { orders: number; revenue: number }>> = {};
      const products: Record<string, { title: string; quantity: number; revenue: Record<string, number> }> = {};
      const payStatus: Record<string, number> = {};

      for (const o of orders) {
        const cur = (o.currency_code ?? "?").toUpperCase();
        const g = (byCur[cur] ??= newAgg());
        const qty = (o.items ?? []).reduce((s: number, i: any) => s + Number(i.quantity ?? 0), 0);
        g.orders++;
        g.revenue += Number(o.total ?? 0);
        g.items_total += Number(o.item_total ?? 0);
        g.subtotal += Number(o.subtotal ?? 0);
        g.shipping += Number(o.shipping_total ?? 0);
        g.tax += Number(o.tax_total ?? 0);
        g.discounts += Number(o.discount_total ?? 0);
        g.items_sold += qty;
        g.customers.add(o.customer_id ?? o.email ?? o.id);
        payStatus[o.payment_status] = (payStatus[o.payment_status] ?? 0) + 1;

        if (a.group_by !== "none") {
          const d = localDate(o.created_at, a.timezone);
          const key = a.group_by === "day" ? d : a.group_by === "week" ? isoWeekKey(d) : d.slice(0, 7);
          const s = ((series[key] ??= {})[cur] ??= { orders: 0, revenue: 0 });
          s.orders++;
          s.revenue += Number(o.total ?? 0);
        }
        for (const i of o.items ?? []) {
          const k = i.product_id ?? i.variant_sku ?? i.title;
          const p = (products[k] ??= { title: i.product_title ?? i.title, quantity: 0, revenue: {} });
          p.quantity += Number(i.quantity ?? 0);
          p.revenue[cur] = round2((p.revenue[cur] ?? 0) + Number(i.total ?? 0));
        }
      }

      const totals = Object.fromEntries(
        Object.entries(byCur).map(([cur, g]) => [
          cur,
          {
            orders: g.orders,
            revenue: round2(g.revenue),
            avg_order_value: g.orders ? round2(g.revenue / g.orders) : 0,
            items_total: round2(g.items_total),
            subtotal: round2(g.subtotal),
            shipping: round2(g.shipping),
            tax: round2(g.tax),
            discounts: round2(g.discounts),
            items_sold: g.items_sold,
            unique_customers: g.customers.size,
          },
        ]),
      );

      return {
        period: { from: a.from, to: a.to, timezone: a.timezone },
        orders_considered: orders.length,
        orders_excluded: res.items.length - orders.length,
        data_truncated: res.truncated || undefined,
        totals,
        payment_status_breakdown: payStatus,
        series:
          a.group_by === "none"
            ? undefined
            : Object.entries(series)
                .sort(([x], [y]) => x.localeCompare(y))
                .map(([period, cur]) => ({
                  period,
                  ...Object.fromEntries(
                    Object.entries(cur).map(([c, v]) => [c, { orders: v.orders, revenue: round2(v.revenue) }]),
                  ),
                })),
        top_products: Object.entries(products)
          .map(([id, p]) => ({ product_id: id, ...p }))
          .sort((x, y) => y.quantity - x.quantity)
          .slice(0, a.top_n),
        note:
          "Revenue = order total (incl. tax and shipping). items_total = line items incl. tax, without shipping. " +
          "subtotal = items + shipping before tax (Medusa's definition). Later refunds are not subtracted.",
      };
    }),
  );

  if (cfg.readOnly) return;

  // ================= WRITE TOOLS =================

  server.registerTool(
    "create_fulfillment",
    {
      title: "Create fulfillment",
      description:
        "Creates a fulfillment for an order. Without 'items' it fulfills all remaining unfulfilled quantities. " +
        "Without 'location_id' it uses the only stock location, if there is exactly one.",
      inputSchema: {
        order: z.string().describe("Order ID or order number"),
        location_id: z.string().optional().describe("Stock location to ship from"),
        items: z
          .array(z.object({ line_item_id: z.string(), quantity: z.number().int().positive() }))
          .optional()
          .describe("Specific line items; defaults to everything remaining"),
        notify_customer: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    wrap(async (a) => {
      const id = await resolveOrderId(a.order);
      let items = a.items?.map((i) => ({ id: i.line_item_id, quantity: i.quantity }));
      if (!items) {
        const o = (await medusa.get(`/admin/orders/${id}`, { fields: "id,*items,*items.detail" })).order;
        items = (o.items ?? [])
          .map((i: any) => ({
            id: i.id,
            quantity: Number(i.quantity ?? 0) - Number(i.detail?.fulfilled_quantity ?? 0),
          }))
          .filter((i: any) => i.quantity > 0);
        if (!items!.length) throw new Error("The order has no unfulfilled items.");
      }
      let locationId = a.location_id;
      if (!locationId) {
        const locs = await getStockLocations();
        if (locs.length !== 1)
          throw new Error(
            `Specify location_id – stock locations: ${locs.map((l) => `${l.name} (${l.id})`).join(", ") || "none"}`,
          );
        locationId = locs[0].id;
      }
      const res = await medusa.post(`/admin/orders/${id}/fulfillments`, {
        items,
        location_id: locationId,
        no_notification: !a.notify_customer,
        metadata: {},
      });
      return {
        ok: true,
        order_id: id,
        fulfillment_status: res.order?.fulfillment_status,
        fulfilled_items: items,
        location_id: locationId,
      };
    }),
  );

  server.registerTool(
    "create_shipment",
    {
      title: "Mark as shipped",
      description:
        "Marks a fulfillment as shipped and attaches a tracking number. Without 'fulfillment_id' it uses the only unshipped fulfillment.",
      inputSchema: {
        order: z.string().describe("Order ID or order number"),
        fulfillment_id: z.string().optional(),
        tracking_number: z.string().optional(),
        tracking_url: z.string().optional(),
        notify_customer: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    wrap(async (a) => {
      const id = await resolveOrderId(a.order);
      const o = (await medusa.get(`/admin/orders/${id}`, { fields: "id,*fulfillments,*fulfillments.items" })).order;
      const open = (o.fulfillments ?? []).filter((f: any) => !f.shipped_at && !f.canceled_at);
      const f = a.fulfillment_id
        ? (o.fulfillments ?? []).find((x: any) => x.id === a.fulfillment_id)
        : open.length === 1
          ? open[0]
          : undefined;
      if (!f)
        throw new Error(
          a.fulfillment_id
            ? `Fulfillment ${a.fulfillment_id} not found on this order.`
            : open.length === 0
              ? "The order has no unshipped fulfillment – call create_fulfillment first."
              : `Multiple unshipped fulfillments, specify fulfillment_id: ${open.map((x: any) => x.id).join(", ")}`,
        );
      const body: any = {
        items: (f.items ?? []).map((i: any) => ({ id: i.line_item_id, quantity: i.quantity })),
        no_notification: !a.notify_customer,
        metadata: {},
      };
      if (a.tracking_number || a.tracking_url) {
        body.labels = [
          { tracking_number: a.tracking_number ?? "", tracking_url: a.tracking_url ?? "", label_url: "" },
        ];
      }
      const res = await medusa.post(`/admin/orders/${id}/fulfillments/${f.id}/shipments`, body);
      return { ok: true, order_id: id, fulfillment_id: f.id, fulfillment_status: res.order?.fulfillment_status };
    }),
  );

  server.registerTool(
    "complete_order",
    {
      title: "Complete order",
      description: "Marks the order as completed.",
      inputSchema: { order: z.string().describe("Order ID or order number") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    wrap(async (a) => {
      const id = await resolveOrderId(a.order);
      const res = await medusa.post(`/admin/orders/${id}/complete`, {});
      return { ok: true, order_id: id, status: res.order?.status };
    }),
  );

  server.registerTool(
    "cancel_order",
    {
      title: "Cancel order",
      description:
        "CANCELS the order. Irreversible – get explicit confirmation from the user before calling. The order must not have active fulfillments.",
      inputSchema: { order: z.string().describe("Order ID or order number") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    wrap(async (a) => {
      const id = await resolveOrderId(a.order);
      const res = await medusa.post(`/admin/orders/${id}/cancel`);
      return { ok: true, order_id: id, status: res.order?.status, payment_status: res.order?.payment_status };
    }),
  );

  server.registerTool(
    "update_product",
    {
      title: "Update product",
      description:
        "Updates basic product fields (title, description, status, handle, metadata). Send only the fields that should change.",
      inputSchema: {
        product_id: z.string(),
        title: z.string().optional(),
        subtitle: z.string().optional(),
        description: z.string().optional(),
        handle: z.string().optional(),
        status: z.enum(["draft", "proposed", "published", "rejected"]).optional(),
        metadata: z
          .record(z.string(), z.any())
          .optional()
          .describe("Merged into existing metadata; an empty string deletes a key"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    wrap(async ({ product_id, ...fields }) => {
      const body = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
      if (!Object.keys(body).length) throw new Error("Nothing to update.");
      const before = (
        await medusa.get(`/admin/products/${product_id}`, { fields: "id,title,subtitle,handle,status" })
      ).product;
      const res = await medusa.post(`/admin/products/${product_id}`, body, {
        fields: "id,title,subtitle,handle,status",
      });
      return { ok: true, before, after: res.product };
    }),
  );

  server.registerTool(
    "set_variant_price",
    {
      title: "Set variant price",
      description:
        "Sets the base price (no price rules) of a variant in one currency. All other prices of the variant are preserved. " +
        "The amount is in major currency units (e.g. 49.99 = 49.99 EUR).",
      inputSchema: {
        product_id: z.string(),
        variant_id: z.string(),
        currency_code: z.string().length(3).describe("E.g. eur, usd"),
        amount: z.number().nonnegative(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    wrap(async (a) => {
      const cur = a.currency_code.toLowerCase();
      const path = `/admin/products/${a.product_id}/variants/${a.variant_id}`;
      const v = (await medusa.get(path, { fields: "id,title,sku,*prices" })).variant;
      const prices: any[] = v.prices ?? [];
      const isBase = (p: any) => p.currency_code === cur && (!p.rules || !Object.keys(p.rules).length) && !p.min_quantity;
      const before = prices.find(isBase)?.amount;
      // Medusa replaces the whole prices array – send all existing prices (with ids), changing or adding just one.
      const next = prices.map((p) => ({
        id: p.id,
        currency_code: p.currency_code,
        amount: isBase(p) ? a.amount : p.amount,
        ...(p.min_quantity ? { min_quantity: p.min_quantity } : {}),
        ...(p.max_quantity ? { max_quantity: p.max_quantity } : {}),
        ...(p.rules && Object.keys(p.rules).length ? { rules: p.rules } : {}),
      }));
      if (before === undefined) next.push({ currency_code: cur, amount: a.amount } as any);
      await medusa.post(path, { prices: next });
      return { ok: true, variant: { id: v.id, title: v.title, sku: v.sku }, currency: cur, before, after: a.amount };
    }),
  );

  server.registerTool(
    "set_stock_level",
    {
      title: "Set stock level",
      description:
        "Sets the stocked quantity of an item at a location. Provide either an absolute 'stocked_quantity' or a relative 'adjust_by' (+/-). " +
        "Identify the item by inventory_item_id or SKU. Without location_id the item's only location is used.",
      inputSchema: {
        inventory_item_id: z.string().optional(),
        sku: z.string().optional(),
        location_id: z.string().optional(),
        stocked_quantity: z.number().int().min(0).optional(),
        adjust_by: z.number().int().optional().describe("E.g. +10 when restocking, -2 when writing off"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    wrap(async (a) => {
      if ((a.stocked_quantity === undefined) === (a.adjust_by === undefined))
        throw new Error("Provide exactly one of: stocked_quantity, adjust_by.");
      let item: any;
      if (a.inventory_item_id) {
        item = (
          await medusa.get(`/admin/inventory-items/${a.inventory_item_id}`, { fields: "id,sku,title,*location_levels" })
        ).inventory_item;
      } else if (a.sku) {
        const res = await medusa.get("/admin/inventory-items", {
          sku: a.sku,
          fields: "id,sku,title,*location_levels",
          limit: 2,
        });
        const found = (res.inventory_items ?? []).length;
        if (found === 0)
          throw new Error(
            `No inventory item with SKU ${a.sku}. If the variant exists, it probably does not track inventory ` +
              "(manage_inventory = false) – enable 'Manage inventory' on the variant in the admin first.",
          );
        if (found !== 1) throw new Error(`SKU ${a.sku}: found ${res.count ?? found} inventory items, expected 1.`);
        item = res.inventory_items[0];
      } else throw new Error("Provide inventory_item_id or sku.");

      const levels: any[] = item.location_levels ?? [];
      let level = a.location_id ? levels.find((l) => l.location_id === a.location_id) : undefined;
      if (!a.location_id) {
        if (levels.length !== 1)
          throw new Error(
            `The item is stocked at ${levels.length} locations, specify location_id: ${levels.map((l) => l.location_id).join(", ")}`,
          );
        level = levels[0];
      }
      if (!level)
        throw new Error(
          `Item ${item.sku ?? item.id} has no inventory level at location ${a.location_id}. Assign it to that location in the admin first.`,
        );
      const before = Number(level.stocked_quantity ?? 0);
      const after = a.stocked_quantity ?? before + a.adjust_by!;
      if (after < 0) throw new Error(`The resulting quantity would be negative (${after}).`);
      await medusa.post(`/admin/inventory-items/${item.id}/location-levels/${level.location_id}`, {
        stocked_quantity: after,
      });
      return {
        ok: true,
        inventory_item: { id: item.id, sku: item.sku, title: item.title },
        location_id: level.location_id,
        stocked_before: before,
        stocked_after: after,
        reserved: level.reserved_quantity,
      };
    }),
  );
}
