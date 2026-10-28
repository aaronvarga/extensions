import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Resolve the Vite `@/` alias so the panel loads under node.
registerHooks({
  resolve(specifier, context, next) {
    if (!specifier.startsWith("@/")) return next(specifier, context);
    return next(new URL(`../src/${specifier.slice(2)}.js`, import.meta.url).href, context);
  },
});

test("expand all skips ignored folders and stops at its folder limit", async () => {
  const listed = [];
  let toast = null;
  globalThis.muxy = {
    files: {
      // Every folder holds two more folders and an ignored one, forever.
      list: async (path) => {
        listed.push(path);
        return [
          { path: `${path}a/`, isDirectory: true },
          { path: `${path}b/`, isDirectory: true },
          { path: `${path}node_modules/`, isDirectory: true, isIgnored: true },
        ];
      },
    },
    storage: { get: async () => null, set: async () => undefined },
    events: { subscribe: () => () => undefined },
    toast: async (options) => {
      toast = options;
    },
  };
  globalThis.localStorage ??= { getItem: () => null, setItem: () => undefined };
  try {
    const { FilesPanelApp } = await import("../src/panel/files-panel.js");
    const app = new FilesPanelApp(null);
    await app.expandAll();
    assert.equal(listed.length, 500);
    assert.ok(listed.every((path) => !path.includes("node_modules")));
    assert.match(toast.body, /first 500 folders/);
    app.collapseAll();
    assert.equal(app.expandedDirs.size, 0);
    assert.equal(app.mainCollapsed, true);
  } finally {
    delete globalThis.muxy;
  }
});
