import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { isDirectExecution } from "../src/index.js";

test("bin entrypoint resolves a package-manager symlink before comparison", async () => {
  const realEntry = "C:\\package\\dist\\index.js";
  const linkedEntry = "C:\\bin\\cursor-relay-mcp";
  assert.equal(
    await isDirectExecution(
      linkedEntry,
      pathToFileURL(realEntry).href,
      async () => realEntry,
    ),
    true,
  );
});
