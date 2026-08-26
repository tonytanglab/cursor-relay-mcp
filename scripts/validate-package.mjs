import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const required = [
  "dist/index.js",
  "dist/index.d.ts",
  ".codex-plugin/plugin.json",
  ".mcp.json",
  "skills/delegate-to-cursor-agent/SKILL.md",
  "README.md",
  "README.zh-CN.md",
  "CODEX_INSTALL.zh-CN.md",
  "LICENSE",
];
await Promise.all(required.map((path) => access(resolve(path))));

const packageJson = JSON.parse(await readFile(resolve("package.json"), "utf8"));
const sdkVersion = packageJson.dependencies?.["@cursor/sdk"];
if (sdkVersion !== "1.0.28")
  throw new Error(
    `@cursor/sdk 必须锁定为 1.0.28，实际为 ${String(sdkVersion)}`,
  );
if (/[~^*><=]/u.test(sdkVersion))
  throw new Error("@cursor/sdk 不能使用版本范围");

const manifest = JSON.parse(
  await readFile(resolve(".codex-plugin/plugin.json"), "utf8"),
);
if (manifest.version !== packageJson.version)
  throw new Error("插件与 npm 包版本不一致");
process.stdout.write("package validation passed\n");
