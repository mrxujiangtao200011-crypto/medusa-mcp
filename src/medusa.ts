import type { MedusaConfig } from "./config.js";

export class MedusaError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
  }
}

type QueryValue = string | number | boolean | null | undefined | QueryValue[] | { [k: string]: QueryValue };

/** Serializes nested objects/arrays the way Medusa expects: a[b][$gte]=x, a[]=1&a[]=2 */
export function buildQuery(params: Record<string, QueryValue>): string {
  const out: string[] = [];
  const walk = (key: string, val: QueryValue) => {
    if (val === undefined || val === null || val === "") return;
    if (Array.isArray(val)) {
      val.forEach((v) => walk(`${key}[]`, v));
    } else if (typeof val === "object") {
      for (const [k, v] of Object.entries(val)) walk(`${key}[${k}]`, v);
    } else {
      out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(val))}`);
    }
  };
  for (const [k, v] of Object.entries(params)) walk(k, v);
  return out.join("&");
}

export class MedusaClient {
  private authHeader: string;

  constructor(private cfg: MedusaConfig) {
    // Medusa v2: the secret API key goes in Basic auth as the username with an empty password
    this.authHeader = "Basic " + Buffer.from(`${cfg.apiKey}:`).toString("base64");
  }

  async request<T = any>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    opts: { query?: Record<string, QueryValue>; body?: unknown } = {},
  ): Promise<T> {
    const qs = opts.query ? buildQuery(opts.query) : "";
    const url = `${this.cfg.backendUrl}${path}${qs ? `?${qs}` : ""}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: this.authHeader,
          Accept: "application/json",
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: ctrl.signal,
      });
    } catch (e: any) {
      throw new MedusaError(0, `Cannot reach Medusa (${method} ${path}): ${e?.message ?? e}`);
    } finally {
      clearTimeout(t);
    }
    const text = await res.text();
    let data: any = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) {
      const msg = (data && (data.message || data.error)) || res.statusText;
      throw new MedusaError(res.status, `Medusa ${res.status} ${method} ${path}: ${msg}`, data);
    }
    return data as T;
  }

  get<T = any>(path: string, query?: Record<string, QueryValue>) {
    return this.request<T>("GET", path, { query });
  }
  post<T = any>(path: string, body?: unknown, query?: Record<string, QueryValue>) {
    return this.request<T>("POST", path, { body: body ?? {}, query });
  }

  /** Walks all pages of a list endpoint (capped at maxItems). */
  async listAll<T = any>(
    path: string,
    key: string,
    query: Record<string, QueryValue>,
    maxItems = 5000,
  ): Promise<{ items: T[]; truncated: boolean; count: number }> {
    const pageSize = 200;
    const items: T[] = [];
    let offset = 0;
    let count = 0;
    while (true) {
      const res = await this.get<any>(path, { ...query, limit: pageSize, offset });
      const page: T[] = res[key] ?? [];
      count = res.count ?? page.length;
      items.push(...page);
      offset += page.length;
      if (page.length === 0 || offset >= count) break;
      if (items.length >= maxItems) return { items: items.slice(0, maxItems), truncated: true, count };
    }
    return { items, truncated: false, count };
  }
}
