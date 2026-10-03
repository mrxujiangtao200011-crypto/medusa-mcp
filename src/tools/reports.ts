import { z } from "zod";
import { dateFilter, DEFAULT_TZ, isoWeekKey, localDate, RO, round2, wrap, type ToolContext } from "./helpers.js";

export function registerReportTools(ctx: ToolContext) {
  const { server, medusa } = ctx;

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
}
