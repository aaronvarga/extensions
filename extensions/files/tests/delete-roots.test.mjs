import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Resolve the Vite `@/` alias so file-ops.js loads under node.
registerHooks({
  resolve(specifier, context, next) {
    if (!specifier.startsWith("@/")) return next(specifier, context);
    return next(new URL(`../src/${specifier.slice(2)}.js`, import.meta.url).href, context);
  },
});

test("a delete failing in one folder still reports what the others moved to Trash", async () => {
  const deleted = [];
  let alert = null;
  globalThis.muxy = {
    dialog: {
      confirm: async () => "Delete",
      alert: async (options) => {
        alert = options;
      },
    },
    files: {
      delete: async (paths, options) => {
        if (options?.root === "/work/broken") throw new Error("permission denied");
        deleted.push([options?.root ?? null, paths]);
      },
    },
  };
  try {
    const { delete_paths } = await import("../src/lib/file-ops.js");
    const ok = await delete_paths([
      { rel: "a.txt", root: null },
      { rel: "b.txt", root: "/work/broken" },
      { rel: "c.txt", root: "/work/lib" },
    ]);
    assert.equal(ok, false);
    assert.deepEqual(deleted, [
      [null, ["a.txt"]],
      ["/work/lib", ["c.txt"]],
    ]);
    assert.match(alert.message, /2 of 3 items were moved to Trash/);
    assert.match(alert.message, /broken: permission denied/);
  } finally {
    delete globalThis.muxy;
  }
});
