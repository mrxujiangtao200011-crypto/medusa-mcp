import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const pkg = read("package.json");
const plugin = read(".claude-plugin/plugin.json");
const mcpb = read("mcpb/manifest.json");
const registry = read("server.json");

test("Claude plugin pins the package version it ships with", () => {
  assert.equal(plugin.version, pkg.version);
  assert.ok(plugin.mcpServers.medusa.args.includes(`medusa-mcp@${pkg.version}`));
  assert.match(readFileSync("src/server.ts", "utf8"), new RegExp(`version: "${pkg.version.replace(/\./g, "\\.")}"`));
});

test("plugin and Desktop extension ask for the same settings and pass the same env", () => {
  assert.deepEqual(plugin.userConfig, mcpb.user_config);
  assert.deepEqual(plugin.mcpServers.medusa.env, mcpb.server.mcp_config.env);
});

test("MCP Registry entry matches the npm package", () => {
  assert.equal(registry.name, pkg.mcpName);
  assert.equal(registry.version, pkg.version);
  const npm = registry.packages.find((p) => p.registryType === "npm");
  assert.equal(npm.identifier, pkg.name);
  assert.equal(npm.version, pkg.version);
  assert.deepEqual(
    npm.environmentVariables.map((e) => e.name).sort(),
    Object.keys(plugin.mcpServers.medusa.env).sort(),
  );
});
