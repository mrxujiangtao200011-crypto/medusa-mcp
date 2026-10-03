# medusa-mcp

🇬🇧 [English](README.md)

MCP server pro **Medusa v2 Admin API**. Běží dvěma způsoby:

- **stdio** – lokálně pro Claude Desktop / Claude Code, bez sítě navenek
- **HTTP (Streamable HTTP) + OAuth 2.1** – jako remote konektor pro Claude (web, mobil, desktop) a ChatGPT

Je v [MCP Registry](https://registry.modelcontextprotocol.io) jako `io.github.trhonpavel/medusa-mcp` a je k dispozici i jako **plugin pro Claude Code / Cowork** se skilly a jako **rozšíření pro Claude Desktop** (`.mcpb`) k instalaci jedním klikem.

## Tooly

48 toolů na běžnou správu obchodu. Cokoli dalšího jde přes `medusa_request`.

**Čtení a reporty**

| Tool | Co dělá |
|---|---|
| `get_store_info` | regiony a měny, prodejní kanály, sklady, způsoby dopravy a profily, důvody vratek a refundací |
| `list_orders` / `get_order` | objednávky podle fulltextu, data, zákazníka nebo stavu; detail podle ID nebo čísla (`1042`, `#1042`) včetně plateb, refundací a vratek |
| `list_customers` / `get_customer` | zákazníci (i podle skupiny), historie, útrata |
| `list_customer_groups` | zákaznické skupiny |
| `list_products` / `get_product` | produkty podle stavu, kolekce, kategorie nebo tagu; varianty, možnosti, ceny, skladové položky |
| `list_catalog` | kategorie (strom), kolekce, tagy, typy produktů |
| `list_inventory` | stav skladu po skladech, `low_stock_threshold` pro dochází |
| `list_promotions` | slevové kódy s hodnotou, podmínkami, využitím a platností |
| `list_price_lists` | akční a skupinové ceníky včetně cen |
| `sales_report` | obrat, AOV, kusy, zákazníci, časová řada den/týden/měsíc, top produkty |

**Zápis** (s `MEDUSA_READ_ONLY=true` se nezaregistrují)

| Oblast | Tooly |
|---|---|
| Vyřízení | `create_fulfillment` (default vše zbývající, jediný sklad), `create_shipment` (sledovací číslo), `mark_delivered`, `cancel_fulfillment` |
| Objednávky | `update_order` (e-mail, adresy, metadata), `complete_order`, `cancel_order` |
| Platby | `mark_order_paid` (převod, dobírka), `capture_payment`, `refund_payment` (hlídá vratnou částku) |
| Vratky | `create_return` (default vše odeslané), `receive_return` (vrátí zboží na sklad) |
| Koncepty objednávek | `create_draft_order` (položky podle varianty nebo SKU, vlastní ceny, doprava), `convert_draft_order` |
| Produkty | `create_product` (jednoduchý nebo s možnostmi a variantami, počáteční sklad, výchozí kanál a profil dopravy), `update_product`, `delete_product` (vyžaduje `confirm_title`) |
| Varianty | `create_variant` (nové hodnoty možností doplní sám), `update_variant`, `delete_variant` (vyžaduje `confirm`), `set_variant_price` (ostatní ceny zůstanou) |
| Katalog | `save_category`, `delete_category`, `save_collection`, `delete_collection` (založení/úprava, přidání a odebrání produktů) |
| Sklad | `set_stock_level` (absolutně nebo `adjust_by: +10`, umí přidat položku na nový sklad) |
| Zákazníci | `save_customer` (založení/úprava, adresa, skupiny), `save_customer_group`, `delete_customer_group` |
| Promo akce | `create_promotion` (procenta, částka nebo doprava zdarma; produkty, kategorie, kolekce, skupiny; platnost a limit použití), `update_promotion`, `delete_promotion` |
| Ceníky | `save_price_list` (akční a B2B ceny, ceny podle varianty nebo SKU), `delete_price_list` |

**Obecný přístup**

| Tool | Co dělá |
|---|---|
| `medusa_request` | libovolný endpoint Admin API (`GET`, `POST`, `DELETE` pod `/admin/`) pro věci bez vlastního toolu – rezervace, úpravy objednávek, výměny, daňové sazby… V read-only režimu jen `GET`; zápis do `api-keys`, `users` a `invites` je vždy zablokovaný. Vypíná se `MEDUSA_RAW_API=false`. |

Částky jsou v hlavních jednotkách měny (Medusa v2 neukládá haléře). Data (`2026-09-01`) se berou v `REPORT_TIMEZONE` (výchozí `UTC`, pro ČR nastav `Europe/Prague`).
Destruktivní tooly (zrušení, mazání, refundace, stržení platby, `medusa_request`) mají `destructiveHint`, takže se klient před spuštěním zeptá.

## 1. API klíč v Meduse

V Medusa Adminu: **Settings → Developer → Secret API Keys → Create**. Klíč (`sk_…`) má práva uživatele, který ho vytvořil – ideálně si na to založ samostatného admin uživatele, ať jde klíč kdykoliv revokovat bez dopadu na tvůj účet.

## 2. Lokálně (stdio)

### Plugin pro Claude Code / Cowork

```bash
claude plugin marketplace add trhonpavel/medusa-mcp
claude plugin install medusa@medusa-mcp
```

Při zapnutí pluginu se Claude Code zeptá na URL backendu a API klíč (klíč se uloží do systémové klíčenky). Zapisovací nástroje jsou vypnuté, dokud v `/config` nevypneš **Read-only**. Plugin přidává dva skilly:

- `store-briefing` – včerejší prodeje a prodeje od začátku měsíce, zaplacené objednávky čekající na odeslání, docházející zboží
- `fulfill-orders` – vyřízení zaplacených objednávek a doplnění trackingu, až po tvém potvrzení seznamu

### Rozšíření pro Claude Desktop

Stáhni `medusa-mcp-<verze>.mcpb` z [posledního release](https://github.com/trhonpavel/medusa-mcp/releases/latest) a otevři ho, nebo ho přetáhni do **Settings → Extensions**. Claude Desktop se zeptá na stejná nastavení a spustí server ve vestavěném Node.js. Sestavit ho můžeš i sám přes `npm run build:mcpb`.

### Ruční konfigurace

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

### ChatGPT

V ChatGPT zapni v nastavení **developer mode** a vytvoř aplikaci (konektor) s URL MCP serveru **`https://mcp.example.com/mcp`** a autentizací OAuth. ChatGPT se zaregistruje stejně a přesměrovává na `chatgpt.com`, který je ve výchozím `ALLOWED_REDIRECT_HOSTS`. Server vrací parametr `iss` podle RFC 9207, takže ChatGPT použije svou stabilní callback URL.

### Claude Code

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
- Zápisové tooly nejsou `readOnlyHint` a ty, které ruší, mažou nebo hýbou penězi, mají `destructiveHint` – Claude u nich žádá o schválení.
- `medusa_request` dosáhne jen na cesty `/admin/…`, nikdy nezapisuje do `api-keys`, `users` ani `invites` (prompt injection tak nevyrobí nové přístupy) a jde vypnout přes `MEDUSA_RAW_API=false`.
- `TRUST_PROXY` nastav na počet proxy před serverem, jinak rate limit uvidí jen IP proxy.

## Vývoj

```bash
npm test           # build + testy proti mock Meduse (tooly i celý OAuth flow)
npm run smoke      # read-only kontrola proti skutečné Meduse (vypisuje jen strukturu, ne data)
npm run dev        # HTTP režim přes tsx
```

## Licence

[MIT](LICENSE)
