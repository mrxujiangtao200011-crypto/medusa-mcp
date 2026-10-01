import express from "express";
import { rateLimit } from "express-rate-limit";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  mcpAuthRouter,
  createOAuthMetadata,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { metadataHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/metadata.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { loadHttpConfig, loadMedusaConfig } from "./config.js";
import { MedusaClient } from "./medusa.js";
import { OwnerPasswordOAuthProvider, withIssuer } from "./oauth.js";
import { createServer } from "./server.js";

export async function startHttp() {
  const http = loadHttpConfig();
  const mcfg = loadMedusaConfig();
  const medusa = new MedusaClient(mcfg);
  const base = new URL(http.publicUrl);
  const mcpUrl = new URL("/mcp", base);
  const provider = new OwnerPasswordOAuthProvider(http, base.href);

  const app = express();
  const tp = http.trustProxy;
  app.set("trust proxy", /^\d+$/.test(tp) ? Number(tp) : tp === "true" ? true : tp);
  app.disable("x-powered-by");

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  // RFC 9207: every authorization response carries `iss`. ChatGPT only uses its stable
  // redirect URI when the server advertises this. Registered before mcpAuthRouter so it
  // replaces the SDK's metadata, and the redirect wrapper also covers the SDK's own
  // error redirects from /authorize.
  const oauthMetadata = {
    ...createOAuthMetadata({ provider, issuerUrl: base, scopesSupported: [] }),
    authorization_response_iss_parameter_supported: true,
  };
  app.use("/.well-known/oauth-authorization-server", metadataHandler(oauthMetadata));
  app.use("/authorize", (_req, res, next) => {
    const redirect = res.redirect.bind(res) as (status: number, url: string) => void;
    res.redirect = ((a: number | string, b?: string) => {
      const [status, url] = typeof a === "number" ? [a, b!] : [302, a];
      redirect(status, withIssuer(url, provider.issuer));
    }) as typeof res.redirect;
    next();
  });

  // OAuth: /.well-known/*, /authorize, /token, /register, /revoke
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: base,
      resourceServerUrl: mcpUrl,
      resourceName: "Medusa e-shop",
      scopesSupported: [],
    }),
  );

  // Password form – strict rate limit against guessing
  app.post(
    "/oauth/login",
    rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: "draft-7", legacyHeaders: false }),
    express.urlencoded({ extended: false, limit: "4kb" }),
    (req, res) => {
      const { pending, password, action } = req.body ?? {};
      const r = provider.completeLogin(String(pending ?? ""), String(password ?? ""), action === "approve");
      if (r.redirect) return res.redirect(302, r.redirect);
      res.status(r.error === "Wrong password." ? 401 : 400);
      provider.renderLogin(res, String(pending ?? ""), r.error);
    },
  );

  const auth = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
  });

  // Stateless Streamable HTTP: a fresh server + transport per request
  app.post("/mcp", auth, express.json({ limit: "1mb" }), async (req, res) => {
    const server: McpServer = createServer(medusa, mcfg);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error("[medusa-mcp] error while handling request", e);
      if (!res.headersSent)
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  });
  const notAllowed = (_req: express.Request, res: express.Response) => {
    res
      .status(405)
      .set("Allow", "POST")
      .json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  };
  app.get("/mcp", auth, notAllowed);
  app.delete("/mcp", auth, notAllowed);

  app.listen(http.port, http.host, () => {
    console.error(
      `[medusa-mcp] HTTP on ${http.host}:${http.port} – MCP endpoint ${mcpUrl.href}` +
        (mcfg.readOnly ? " (read-only)" : ""),
    );
  });
}
