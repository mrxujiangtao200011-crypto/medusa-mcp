// Runs from the npm "version" hook: copies the new package.json version into the
// Claude plugin manifest (including the pinned npx package) and the server info.
import { readFileSync, writeFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));

const pluginPath = ".claude-plugin/plugin.json";
const plugin = JSON.parse(readFileSync(pluginPath, "utf8"));
plugin.version = version;
plugin.mcpServers.medusa.args = plugin.mcpServers.medusa.args.map((a) =>
  a.startsWith("medusa-mcp@") ? `medusa-mcp@${version}` : a,
);
writeFileSync(pluginPath, JSON.stringify(plugin, null, 2) + "\n");

const serverPath = "src/server.ts";
writeFileSync(
  serverPath,
  readFileSync(serverPath, "utf8").replace(/name: "medusa-mcp", version: "[^"]+"/, `name: "medusa-mcp", version: "${version}"`),
);
console.log(`synced version ${version}`);
