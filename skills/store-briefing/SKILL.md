---
name: store-briefing
description: Daily briefing for a Medusa store – yesterday's and month-to-date sales, orders waiting to be fulfilled, and products running low on stock. Use when the user asks how the shop is doing, for a morning summary, or what needs attention today.
---

# Store briefing

Build a short briefing from the Medusa tools. Run the independent calls in parallel.

1. `sales_report` for yesterday (`from` = `to` = yesterday, `group_by: "none"`, `top_n: 5`) and for the month to date (`group_by: "none"`, `top_n: 5`). Dates are in the store's reporting timezone.
2. `list_orders` with `fulfillment_status: ["not_fulfilled", "partially_fulfilled"]` and `payment_status: ["captured", "authorized"]` – paid orders waiting to ship. Note the oldest one and how many days it has waited.
3. `list_inventory` with `low_stock_threshold: 3`.

Report, in this order:

- **Needs action**: orders waiting to ship (number, customer, age) and items at 0 or below the threshold. If there is nothing, say so in one line.
- **Sales**: yesterday vs. month to date – orders, revenue, average order value, per currency. Use `items_total` when the user asks about goods only, since `subtotal` includes shipping.
- **Top products** this month.

Keep it scannable. Do not call write tools from this skill; offer `fulfill-orders` if orders are waiting.
