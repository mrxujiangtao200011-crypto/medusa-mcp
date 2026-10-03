import { z } from "zod";
import {
  addressSchema,
  defined,
  DESTRUCTIVE,
  idList,
  limitSchema,
  metadataSchema,
  offsetSchema,
  ORDER_LIST_FIELDS,
  RO,
  round2,
  summarizeOrder,
  UPDATE,
  wrap,
  type ToolContext,
} from "./helpers.js";

const CUSTOMER_FIELDS = "id,email,first_name,last_name,company_name,phone,has_account,created_at";

export function registerCustomerTools(ctx: ToolContext) {
  const { server, medusa, cfg } = ctx;

  server.registerTool(
    "list_customers",
    {
      title: "List customers",
      description: "Searches customers by name, email or company, optionally within a customer group.",
      inputSchema: {
        q: z.string().optional().describe("Full-text search – name, email, company"),
        email: z.string().optional(),
        has_account: z.boolean().optional().describe("true = registered, false = guests"),
        group_id: z.string().optional().describe("Only members of this customer group"),
        limit: limitSchema,
        offset: offsetSchema,
      },
      annotations: RO,
    },
    wrap(async (a) => {
      const res = await medusa.get("/admin/customers", {
        fields: CUSTOMER_FIELDS,
        order: "-created_at",
        q: a.q,
        email: a.email,
        has_account: a.has_account,
        groups: a.group_id ? [a.group_id] : undefined,
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

  server.registerTool(
    "list_customer_groups",
    {
      title: "List customer groups",
      description: "Customer groups (e.g. B2B, VIP) – used by price lists and promotions.",
      inputSchema: { q: z.string().optional(), limit: limitSchema, offset: offsetSchema },
      annotations: RO,
    },
    wrap(async (a) => {
      const res = await medusa.get("/admin/customer-groups", {
        fields: "id,name,metadata,created_at",
        q: a.q,
        order: "name",
        limit: a.limit,
        offset: a.offset,
      });
      return { count: res.count, offset: res.offset, customer_groups: res.customer_groups ?? [] };
    }),
  );

  if (cfg.readOnly) return;

  server.registerTool(
    "save_customer",
    {
      title: "Create or update customer",
      description:
        "Without customer_id creates a customer (email required); with customer_id updates only the given fields. " +
        "Can also add an address and add/remove the customer from groups.",
      inputSchema: {
        customer_id: z.string().optional(),
        email: z.string().optional(),
        first_name: z.string().optional(),
        last_name: z.string().optional(),
        company_name: z.string().optional(),
        phone: z.string().optional(),
        metadata: metadataSchema,
        add_address: addressSchema
          .extend({
            is_default_shipping: z.boolean().optional(),
            is_default_billing: z.boolean().optional(),
          })
          .optional(),
        add_to_groups: idList("Customer group IDs to join"),
        remove_from_groups: idList("Customer group IDs to leave"),
      },
      annotations: UPDATE,
    },
    wrap(async (a) => {
      const fields = defined({
        email: a.email,
        first_name: a.first_name,
        last_name: a.last_name,
        company_name: a.company_name,
        phone: a.phone,
        metadata: a.metadata,
      });
      let id = a.customer_id;
      let created = false;
      if (!id) {
        if (!a.email) throw new Error("email is required to create a customer.");
        id = (await medusa.post("/admin/customers", fields, { fields: "id" })).customer.id as string;
        created = true;
      } else if (Object.keys(fields).length) {
        await medusa.post(`/admin/customers/${id}`, fields, { fields: "id" });
      }
      if (a.add_address) await medusa.post(`/admin/customers/${id}/addresses`, a.add_address, { fields: "id" });
      if (a.add_to_groups?.length || a.remove_from_groups?.length)
        await medusa.post(`/admin/customers/${id}/customer-groups`, defined({ add: a.add_to_groups, remove: a.remove_from_groups }));
      const customer = (await medusa.get(`/admin/customers/${id}`, { fields: `${CUSTOMER_FIELDS},*addresses,*groups` }))
        .customer;
      return { ok: true, created, customer };
    }),
  );

  server.registerTool(
    "save_customer_group",
    {
      title: "Create or update customer group",
      description: "Without group_id creates a group (name required); with group_id renames it. Can add/remove customers.",
      inputSchema: {
        group_id: z.string().optional(),
        name: z.string().optional(),
        metadata: metadataSchema,
        add_customers: idList("Customer IDs to add"),
        remove_customers: idList("Customer IDs to remove"),
      },
      annotations: UPDATE,
    },
    wrap(async (a) => {
      const fields = defined({ name: a.name, metadata: a.metadata });
      let id = a.group_id;
      let created = false;
      if (!id) {
        if (!a.name) throw new Error("name is required to create a group.");
        id = (await medusa.post("/admin/customer-groups", fields)).customer_group.id as string;
        created = true;
      } else if (Object.keys(fields).length) {
        await medusa.post(`/admin/customer-groups/${id}`, fields);
      }
      if (a.add_customers?.length || a.remove_customers?.length)
        await medusa.post(`/admin/customer-groups/${id}/customers`, defined({ add: a.add_customers, remove: a.remove_customers }));
      const group = (await medusa.get(`/admin/customer-groups/${id}`, { fields: "id,name,metadata" })).customer_group;
      return { ok: true, created, customer_group: group };
    }),
  );

  server.registerTool(
    "delete_customer_group",
    {
      title: "Delete customer group",
      description:
        "DELETES a customer group (the customers stay). Price lists and promotions targeting it stop applying. Confirm with the user first.",
      inputSchema: { group_id: z.string() },
      annotations: { ...DESTRUCTIVE, idempotentHint: true },
    },
    wrap(async (a) => {
      await medusa.delete(`/admin/customer-groups/${a.group_id}`);
      return { ok: true, deleted: a.group_id };
    }),
  );
}
