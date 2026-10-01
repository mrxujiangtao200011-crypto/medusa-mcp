---
name: fulfill-orders
description: Fulfill and ship paid Medusa orders – create the fulfillment, add the tracking number, and mark the order as shipped. Use when the user wants to process, pack, ship or dispatch orders, or gives tracking numbers for orders.
---

# Fulfill orders

These actions change live orders and usually email the customer, so confirm before writing.

1. Find the orders. If the user named them, call `get_order` for each (an order number like `1042` works). Otherwise call `list_orders` with `fulfillment_status: ["not_fulfilled", "partially_fulfilled"]` and `payment_status: ["captured", "authorized"]`.
2. Show what will happen for each order: number, customer, items and quantities still to fulfill, and the tracking number if given. If an order is unpaid, canceled or already fulfilled, say so and leave it out.
3. Ask the user to confirm the list, and whether customers should be notified (default yes).
4. For each confirmed order:
   - `create_fulfillment` with `order` (all remaining items by default; pass `location_id` if the tool asks for it).
   - If there is a tracking number, `create_shipment` with `order`, `tracking_number` and optionally `tracking_url`.
5. Report the result per order. If one fails, keep going with the others and list the failures with the error at the end.

If the write tools are missing, the server runs read-only: tell the user to turn off read-only in the plugin settings (or `MEDUSA_READ_ONLY`).
