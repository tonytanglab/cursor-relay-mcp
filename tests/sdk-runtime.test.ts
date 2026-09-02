import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { warmCursorSdkRuntime } from "../src/sdk-runtime/index.js";

test("SDK public warmup survives removal of the old plugin cache chunks", async () => {
  const root = await mkdtemp(join(process.cwd(), ".sdk-runtime-test-"));
  const sourceDirectory = resolve("node_modules/@cursor/sdk/dist/esm");
  const sdkDirectory = join(root, "esm");
  await mkdir(sdkDirectory);
  try {
    const runtimeFiles = (await readdir(sourceDirectory)).filter(
      (name) => name === "index.js" || /^\d+\.js$/u.test(name),
    );
    await Promise.all(
      runtimeFiles.map((name) =>
        copyFile(join(sourceDirectory, name), join(sdkDirectory, name)),
      ),
    );
    const sdk = (await import(
      pathToFileURL(join(sdkDirectory, "index.js")).href
    )) as typeof import("@cursor/sdk");
    const store = new sdk.JsonlLocalAgentStore(join(root, "state"));
    const createPlatform = sdk.createAgentPlatform.bind(sdk);
    const listModels = sdk.Cursor.models.list.bind(sdk.Cursor.models);

    await warmCursorSdkRuntime(
      store,
      process.cwd(),
      createPlatform,
      listModels,
    );
    await Promise.all(
      runtimeFiles
        .filter((name) => /^\d+\.js$/u.test(name))
        .map((name) => rm(join(sdkDirectory, name), { force: true })),
    );

    const platform = await sdk.createAgentPlatform({ localStore: store });
    const release = await platform.prewarmLocalWorkspace({
      model: { id: "default" },
      local: {
        cwd: process.cwd(),
        store,
        settingSources: [],
        sandboxOptions: { enabled: false },
        enableAgentRetries: true,
      },
    });
    await release();
    await assert.rejects(
      sdk.Cursor.models.list({ apiKey: "cursor-relay\nwarmup" }),
      (error: unknown) =>
        error instanceof Error &&
        error.name === "NetworkError" &&
        !("code" in error && error.code === "ERR_MODULE_NOT_FOUND"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
