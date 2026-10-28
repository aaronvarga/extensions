import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Resolve the Vite `@/` alias so the module loads under node.
registerHooks({
  resolve(specifier, context, next) {
    if (!specifier.startsWith("@/")) return next(specifier, context);
    return next(new URL(`../src/${specifier.slice(2)}.js`, import.meta.url).href, context);
  },
});

test("each project keeps its own expanded folders and root collapse", async () => {
  const store = new Map();
  const listeners = [];
  let cwd = "/work/app";
  globalThis.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
  };
  globalThis.muxy = {
    // No worktrees:read permission, as in the manifest.
    worktrees: { list: async () => Promise.reject(new Error("permission denied")) },
    exec: async () => ({ exitCode: 0, stdout: `${cwd}\n` }),
    events: { subscribe: (_name, fn) => listeners.push(fn) },
  };
  const switch_project = (next) => {
    cwd = next;
    for (const fn of listeners) fn();
  };
  try {
    const { load_tree_memory, save_tree_memory } = await import("../src/lib/tree-memory.js");
    await save_tree_memory(new Set(["src/"]), "src/main.rs", true);
    switch_project("/work/lib");
    assert.deepEqual(await load_tree_memory(), { expanded: [], selected: null, collapsed: false });
    await save_tree_memory(new Set(["docs/"]), null, false);
    switch_project("/work/app");
    assert.deepEqual(await load_tree_memory(), { expanded: ["src/"], selected: "src/main.rs", collapsed: true });
  } finally {
    delete globalThis.muxy;
    delete globalThis.localStorage;
  }
});
