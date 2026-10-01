# medusa-mcp

🇬🇧 [English](README.md)

MCP server pro **Medusa v2 Admin API**. Běží dvěma způsoby:

- **stdio** – lokálně pro Claude Desktop / Claude Code, bez sítě navenek
- **HTTP (Streamable HTTP) + OAuth 2.1** – jako vlastní konektor v Claude (web, mobil, desktop)

## Tooly

| Tool | Co dělá | Typ |
|---|---|---|
| `get_store_info` | regiony a měny, prodejní kanály, sklady | čtení |
| `list_orders` | objednávky – fulltext, datum, zákazník, stav, stav platby/vyřízení | čtení |
| `get_order` | detail objednávky podle ID nebo čísla (`1042`, `#1042`) | čtení |
| `list_customers` / `get_customer` | zákazníci, historie, útrata | čtení |
| `list_products` / `get_product` | produkty, varianty, ceny, propojené skladové položky | čtení |
| `list_inventory` | stav skladu po skladech, `low_stock_threshold` pro dochází | čtení |
| `sales_report` | obrat, AOV, kusy, zákazníci, časová řada den/týden/měsíc, top produkty | report |
| `create_fulfillment` | vychystání objednávky (default vše zbývající, jediný sklad) | zápis |
| `create_shipment` | odesláno + sledovací číslo | zápis |
| `complete_order` | dokončit objednávku | zápis |
| `cancel_order` | zrušit objednávku (`destructiveHint`) | zápis |
| `update_product` | název, popis, stav publikace, handle, metadata | zápis |
| `delete_product` | smazat produkt s variantami a jejich nerezervované skladové položky; vyžaduje `confirm_title` (`destructiveHint`) | zápis |
| `set_variant_price` | cena varianty v měně – ostatní ceny (i s pravidly) zůstanou | zápis |
| `set_stock_level` | naskladnění: absolutně nebo `adjust_by` ±, podle SKU | zápis |

Částky jsou v hlavních jednotkách měny (Medusa v2 neukládá haléře). Data ve filtrech (`2026-09-01`) se berou v `REPORT_TIMEZONE` (výchozí `UTC`, pro ČR nastav `Europe/Prague`).
S `MEDUSA_READ_ONLY=true` se zápisové tooly vůbec nezaregistrují.

## 1. API klíč v Meduse

V Medusa Adminu: **Settings → Developer → Secret API Keys → Create**. Klíč (`sk_…`) má práva uživatele, který ho vytvořil – ideálně si na to založ samostatného admin uživatele, ať jde klíč kdykoliv revokovat bez dopadu na tvůj účet.

## 2. Lokálně (stdio)

Claude Desktop – `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "medusa": {
      "command": "npx",
      "args": ["-y", "medusa-mcp", "stdio"],
      "env": {
        "MEDUSA_BACKEND_URL": "https://api.example.com",
        "MEDUSA_API_KEY": "sk_..."
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

## 3. Remote konektor (HTTP + OAuth)

```bash
docker run -d --name medusa-mcp -p 127.0.0.1:3000:3000 -v medusa-mcp-data:/data \
  -e MEDUSA_BACKEND_URL=https://api.example.com \
  -e MEDUSA_API_KEY=sk_... \
  -e PUBLIC_URL=https://mcp.example.com \
  -e OWNER_PASSWORD="$(openssl rand -base64 24)" \
  -e REPORT_TIMEZONE=Europe/Prague \
  ghcr.io/trhonpavel/medusa-mcp:latest
```

Nebo naklonuj repo, zkopíruj `.env.example` do `.env` a spusť `docker compose up -d --build`.

Server poslouchá na `127.0.0.1:3000`, ven ho pusť přes reverse proxy s TLS. Claude se ke konektoru připojuje ze svých serverů, takže endpoint musí být **veřejně dostupný přes HTTPS**. Příklad pro Caddy:

```
mcp.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

V Claude pak přidej vlastní konektor s URL **`https://mcp.example.com/mcp`**. Claude se sám zaregistruje (DCR), otevře přihlašovací stránku, tam zadáš `OWNER_PASSWORD` a povolíš přístup.

Claude Code proti remote serveru se statickým tokenem (`MCP_STATIC_TOKEN`):

```bash
claude mcp add --transport http medusa https://mcp.example.com/mcp \
  --header "Authorization: Bearer <MCP_STATIC_TOKEN>"
```

…nebo bez hlavičky – Claude Code umí stejný OAuth flow jako web.

### Endpointy

| Cesta | Účel |
|---|---|
| `POST /mcp` | MCP (Streamable HTTP, stateless), vyžaduje Bearer token |
| `/.well-known/oauth-protected-resource/mcp` | RFC 9728 metadata |
| `/.well-known/oauth-authorization-server` | RFC 8414 metadata |
| `/register`, `/authorize`, `/token`, `/revoke` | OAuth 2.1 (DCR, PKCE S256) |
| `POST /oauth/login` | formulář s heslem vlastníka (rate limit 10 / 15 min / IP) |
| `GET /healthz` | healthcheck |

## Bezpečnost

Hlášení zranitelností viz [SECURITY.md](SECURITY.md).


- Medusa API klíč zůstává jen na serveru, Claude dostává vlastní krátkodobé tokeny (1 h, refresh 30 dní s rotací).
- Tokeny se ukládají jen jako SHA-256 hash do `DATA_DIR/oauth-state.json` (práva 600). Smazáním souboru odhlásíš všechny klienty.
- DCR povoluje jen redirecty na hosty z `ALLOWED_REDIRECT_HOSTS` – cizí aplikace se nemůže zaregistrovat s vlastním callbackem.
- Autorizační kódy jsou jednorázové, platí 5 minut, PKCE S256 je povinné.
- Přihlašovací stránka: CSP `default-src 'none'`, `X-Frame-Options: DENY`, porovnání hesla v konstantním čase.
- `cancel_order` a `delete_product` mají `destructiveHint`, zápisové tooly nejsou `readOnlyHint` – Claude u nich žádá o schválení.
- `TRUST_PROXY` nastav na počet proxy před serverem, jinak rate limit uvidí jen IP proxy.

## Vývoj

```bash
npm test           # build + testy proti mock Meduse (tooly i celý OAuth flow)
npm run smoke      # read-only kontrola proti skutečné Meduse (vypisuje jen strukturu, ne data)
npm run dev        # HTTP režim přes tsx
```

## Licence

[MIT](LICENSE)
