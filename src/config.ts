function req(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[medusa-mcp] Missing environment variable ${name}`);
    process.exit(1);
  }
  return v;
}

function bool(name: string, def = false): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function secretKey(): string {
  const key = req("MEDUSA_API_KEY").trim();
  if (key.startsWith("pk_")) {
    console.error(
      "[medusa-mcp] MEDUSA_API_KEY is a publishable key (pk_…), which only works with the Store API. " +
        "Create a secret key in Medusa Admin → Settings → Developer → Secret API Keys (it starts with sk_).",
    );
    process.exit(1);
  }
  return key;
}

export function loadMedusaConfig() {
  return {
    backendUrl: req("MEDUSA_BACKEND_URL").replace(/\/+$/, ""),
    apiKey: secretKey(),
    /** When true, write tools are not registered at all. */
    readOnly: bool("MEDUSA_READ_ONLY", false),
    timeoutMs: Number(process.env.MEDUSA_TIMEOUT_MS ?? 20000),
  };
}

export function loadHttpConfig() {
  const publicUrl = req("PUBLIC_URL").replace(/\/+$/, "");
  return {
    publicUrl,
    port: Number(process.env.PORT ?? 3000),
    host: process.env.HOST ?? "0.0.0.0",
    /** Password the owner enters on the consent page when connecting a client. */
    ownerPassword: req("OWNER_PASSWORD"),
    /** Optional static bearer token (e.g. for Claude Code via a header). */
    staticToken: process.env.MCP_STATIC_TOKEN || undefined,
    dataDir: process.env.DATA_DIR ?? "./data",
    /** Hosts OAuth clients may register as redirect (callback) targets. */
    allowedRedirectHosts: (process.env.ALLOWED_REDIRECT_HOSTS ??
      "claude.ai,claude.com,localhost,127.0.0.1")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    accessTokenTtlSec: Number(process.env.ACCESS_TOKEN_TTL ?? 3600),
    refreshTokenTtlSec: Number(process.env.REFRESH_TOKEN_TTL ?? 60 * 60 * 24 * 30),
    trustProxy: process.env.TRUST_PROXY ?? "1",
  };
}

export type MedusaConfig = ReturnType<typeof loadMedusaConfig>;
export type HttpConfig = ReturnType<typeof loadHttpConfig>;
