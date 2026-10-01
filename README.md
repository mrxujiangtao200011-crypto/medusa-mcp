# medusa-mcp

🇨🇿 [Česky](README.cs.md)

An [MCP](https://modelcontextprotocol.io) server for the **Medusa v2 Admin API**. It gives Claude (or any MCP client) access to orders, customers, products and inventory, computes sales reports, and performs a small set of carefully scoped write actions.

It runs in two modes:

- **stdio** – locally for Claude Desktop, Claude Code and other MCP clients
- **Streamable HTTP + OAuth 2.1** – as a remote custom connector you can use from Claude on the web, desktop and mobile

## Tools

| Tool | What it does | Kind |
|---|---|---|
| `get_store_info` | regions and currencies, sales channels, stock locations | read |
| `list_orders` | orders – full-text, date range, customer, order/payment/fulfillment status | read |
| `get_order` | full order detail by ID or order number (`1042`, `#1042`) | read |
| `list_customers` / `get_customer` | customers, order history, total spent | read |
| `list_products` / `get_product` | products, variants, prices, linked inventory items | read |
| `list_inventory` | stock per location, `low_stock_threshold` to find what's running out | read |
| `sales_report` | revenue, AOV, units, unique customers, day/week/month series, top products | report |
| `create_fulfillment` | fulfill an order (defaults: all remaining items, the only stock location) | write |
| `create_shipment` | mark as shipped with a tracking number | write |
| `complete_order` | mark an order as completed | write |
| `cancel_order` | cancel an order (`destructiveHint`) | write |
| `update_product` | title, description, status, handle, metadata | write |
| `delete_product` | delete a product and its variants, plus their unreserved inventory items; requires `confirm_title` (`destructiveHint`) | write |
| `set_variant_price` | set a variant's base price in one currency – all other prices, including ones with price rules, are preserved | write |
| `set_stock_level` | restock by SKU, absolute or relative (`adjust_by: +10`) | write |

Amounts are in major currency units (Medusa v2 does not store minor units). Plain dates in filters (`2026-09-01`) are interpreted in `REPORT_TIMEZONE` (default `UTC`).
With `MEDUSA_READ_ONLY=true` the write tools are not registered at all.

## 1. Create a Medusa API key

In the Medusa Admin go to **Settings → Developer → Secret API Keys → Create**. The key (`sk_…`) acts with the permissions of the user who created it, so consider a dedicated admin user that you can revoke independently.

## 2. Local use (stdio)

Claude Desktop – `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "medusa": {
      "command": "npx",
      "args": ["-y", "medusa-mcp", "stdio"],
      "env": {
        "MEDUSA_BACKEND_URL": "https://api.example.com",
        "MEDUSA_API_KEY": "sk_...",
        "MEDUSA_READ_ONLY": "true"
      }
    }
  }
}
```

Claude Code:

```bash
claude mcp add medusa \
  -e MEDUSA_BACKEND_URL=https://api.example.com -e MEDUSA_API_KEY=sk_... \
  -- npx -y medusa-mcp stdio
```

## 3. Remote connector (HTTP + OAuth)

```bash
docker run -d --name medusa-mcp -p 127.0.0.1:3000:3000 -v medusa-mcp-data:/data \
  -e MEDUSA_BACKEND_URL=https://api.example.com \
  -e MEDUSA_API_KEY=sk_... \
  -e PUBLIC_URL=https://mcp.example.com \
  -e OWNER_PASSWORD="$(openssl rand -base64 24)" \
  ghcr.io/trhonpavel/medusa-mcp:latest
```

Or clone the repo, copy `.env.example` to `.env` and run `docker compose up -d --build`.

The server listens on `127.0.0.1:3000`; expose it through a reverse proxy with TLS. Claude connects to remote connectors from Anthropic's servers, so the endpoint must be **publicly reachable over HTTPS**. Caddy example:

```
mcp.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Then add a custom connector in Claude with the URL **`https://mcp.example.com/mcp`**. Claude registers itself (Dynamic Client Registration), opens the consent page, you enter `OWNER_PASSWORD` and click Allow.

Claude Code can use the same OAuth flow, or a static token if you set `MCP_STATIC_TOKEN`:

```bash
claude mcp add --transport http medusa https://mcp.example.com/mcp \
  --header "Authorization: Bearer <MCP_STATIC_TOKEN>"
```

### Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `MEDUSA_BACKEND_URL` | yes | | Medusa backend URL |
| `MEDUSA_API_KEY` | yes | | Secret API key (`sk_…`) |
| `MEDUSA_READ_ONLY` | | `false` | Register read and report tools only |
| `REPORT_TIMEZONE` | | `UTC` | IANA timezone for date filters and report buckets |
| `MEDUSA_TIMEOUT_MS` | | `20000` | Timeout for Medusa requests |
| `PUBLIC_URL` | HTTP | | Public HTTPS origin of this server (without `/mcp`) |
| `OWNER_PASSWORD` | HTTP | | Password required on the consent page |
| `MCP_STATIC_TOKEN` | | | Optional static bearer token |
| `ALLOWED_REDIRECT_HOSTS` | | `claude.ai,claude.com,localhost,127.0.0.1` | Hosts OAuth clients may use as redirect targets |
| `TRUST_PROXY` | | `1` | Express `trust proxy` – number of proxies in front |
| `PORT` / `HOST` | | `3000` / `0.0.0.0` | Listen address |
| `DATA_DIR` | | `./data` | Where OAuth clients and token hashes are stored |
| `ACCESS_TOKEN_TTL` / `REFRESH_TOKEN_TTL` | | `3600` / `2592000` | Token lifetimes in seconds |

### Endpoints

| Path | Purpose |
|---|---|
| `POST /mcp` | MCP over Streamable HTTP (stateless), requires a bearer token |
| `/.well-known/oauth-protected-resource/mcp` | RFC 9728 protected resource metadata |
| `/.well-known/oauth-authorization-server` | RFC 8414 authorization server metadata |
| `/register`, `/authorize`, `/token`, `/revoke` | OAuth 2.1 (DCR, PKCE S256) |
| `POST /oauth/login` | consent form (rate limited: 10 attempts / 15 min / IP) |
| `GET /healthz` | health check |

## Security model

- The Medusa API key never leaves the server. Clients get their own short-lived tokens (1 h access, 30-day refresh with rotation).
- Only SHA-256 hashes of tokens are stored, in `DATA_DIR/oauth-state.json` (mode 600). Delete the file to sign out every client.
- Dynamic Client Registration only accepts redirect URIs on `ALLOWED_REDIRECT_HOSTS`, so an arbitrary app cannot register its own callback and phish a token.
- Authorization codes are single-use, expire after 5 minutes, and PKCE S256 is mandatory.
- The consent page sends `Content-Security-Policy: default-src 'none'` and `X-Frame-Options: DENY`, and compares the password in constant time.
- Write tools are not marked `readOnlyHint` and `cancel_order` / `delete_product` carry `destructiveHint`, so clients like Claude ask for approval before running them.
- Set `TRUST_PROXY` to the number of reverse proxies in front of the server, otherwise rate limiting only sees the proxy's IP.

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## Development

```bash
npm ci
npm test        # build + tests against a mock Medusa (tools and the full OAuth flow)
npm run smoke   # read-only check against a real Medusa – prints response shapes only, no data
npm run dev     # HTTP mode via tsx
```

`npm run smoke` needs `MEDUSA_BACKEND_URL` and `MEDUSA_API_KEY`. Its output contains only keys and types, so it is safe to paste into an issue.

## License

[MIT](LICENSE)
