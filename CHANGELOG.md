# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `delete_product` with a `confirm_title` safeguard; also removes the variants' unreserved inventory items.
- ChatGPT as a remote connector: `chatgpt.com` is in the default `ALLOWED_REDIRECT_HOSTS`, and authorization responses carry the RFC 9207 `iss` parameter (advertised as `authorization_response_iss_parameter_supported`).
- Claude Code / Cowork plugin (`.claude-plugin/`) with `store-briefing` and `fulfill-orders` skills; the repository is its own plugin marketplace.
- Claude Desktop extension: `npm run build:mcpb` builds `medusa-mcp-<version>.mcpb`, and releases attach it.

## [0.1.0] – 2026-10-01

### Added

- Read tools: `get_store_info`, `list_orders`, `get_order`, `list_customers`, `get_customer`, `list_products`, `get_product`, `list_inventory`.
- `sales_report` with per-currency totals, time series and top products.
- Write tools: `create_fulfillment`, `create_shipment`, `complete_order`, `cancel_order`, `update_product`, `set_variant_price`, `set_stock_level`.
- `MEDUSA_READ_ONLY` mode.
- stdio transport.
- Streamable HTTP transport with a built-in OAuth 2.1 authorization server (DCR with redirect allowlist, PKCE S256, refresh token rotation, owner-password consent page).
- Docker image and `docker-compose.yml`.
- Test suite against a mock Medusa and a read-only `npm run smoke` check for real backends.

### Fixed before release (verified against a real Medusa 2.13 backend)

- `get_order` returned no `display_id`, totals, `email`, `currency_code` or line item totals: a single plain field in `fields` makes Medusa replace its default fields, so every field is now prefixed with `+` or `*`. The mock mirrors this rule.
- `sales_report` adds `items_total` (line items without shipping) and explains that Medusa's `subtotal` includes shipping.
- `get_customer` reports `total_spent` with upper-case currency codes, like `sales_report`.
- `set_stock_level` explains that a variant without an inventory item does not track inventory (`manage_inventory = false`).
- The server refuses a publishable key (`pk_…`) with a clear message instead of failing every call with 401.
- `npm run smoke` checks that key fields are present, because Medusa silently drops fields it does not return.
