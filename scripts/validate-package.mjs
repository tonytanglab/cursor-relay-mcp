import { access, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const required = [
  "dist/index.js",
  "dist/index.d.ts",
  "dist/sdk-runtime/index.js",
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
if (sdkVersion !== "1.0.30")
  throw new Error(
    `@cursor/sdk 必须锁定为 1.0.30，实际为 ${String(sdkVersion)}`,
  );
if (/[~^*><=]/u.test(sdkVersion))
  throw new Error("@cursor/sdk 不能使用版本范围");

const sdkRuntimeDirectory = resolve("node_modules/@cursor/sdk/dist/esm");
const sdkRuntimeEntries = await readdir(sdkRuntimeDirectory);
if (!sdkRuntimeEntries.some((name) => /^\d+\.js$/u.test(name)))
  throw new Error("@cursor/sdk 缺少运行所需的懒加载数字分块");

const manifest = JSON.parse(
  await readFile(resolve(".codex-plugin/plugin.json"), "utf8"),
);
const cachebusterPrefix = `${packageJson.version}+codex.`;
for (const prompt of manifest.interface?.defaultPrompt ?? []) {
  if (typeof prompt !== "string" || prompt.length > 128)
    throw new Error("插件 defaultPrompt 必须是至多 128 字符的字符串");
}
const cachebuster = manifest.version.startsWith(cachebusterPrefix)
  ? manifest.version.slice(cachebusterPrefix.length)
  : "";
if (
  manifest.version !== packageJson.version &&
  !/^[A-Za-z0-9._-]+$/u.test(cachebuster)
)
  throw new Error(
    "插件版本必须等于 npm 包版本或只追加一个 +codex.<cachebuster> 后缀",
  );
process.stdout.write("package validation passed\n");
