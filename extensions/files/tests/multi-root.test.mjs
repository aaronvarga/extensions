import assert from "node:assert/strict";
import test from "node:test";

const MAIN = "/work/app";
const EXTRA_A = "/work/lib-a";
const EXTRA_B = "/work/lib-b";

function editor_tab(id, data) {
  return { tabID: id, extensionID: "files", tabTypeID: "code-editor", data };
}

function memory_storage() {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
}

test("open tabs keep the same relative path in two folders apart", async () => {
  globalThis.muxy = { extensionID: "files" };
  try {
    const { OpenTabsStore } = await import("../src/lib/open-tabs.js");
    const store = new OpenTabsStore();
    store.track(editor_tab("main-tab", { filePath: "src/index.js", replaceable: false }));
    store.track(editor_tab("a-tab", { filePath: "src/index.js", root: EXTRA_A, replaceable: false }));
    store.track(editor_tab("b-tab", { filePath: "src/index.js", root: `${EXTRA_B}/`, replaceable: false }));

    assert.equal(store.tabIdFor("src/index.js"), "main-tab");
    assert.equal(store.tabIdFor("src/index.js", EXTRA_A), "a-tab");
    assert.equal(store.tabIdFor("src/index.js", EXTRA_B), "b-tab");
    assert.deepEqual(store.fileFor("a-tab"), { filePath: "src/index.js", root: EXTRA_A });
    assert.deepEqual(store.fileFor("main-tab"), { filePath: "src/index.js", root: null });

    store.untrack({ tabID: "a-tab" });
    assert.equal(store.tabIdFor("src/index.js", EXTRA_A), null);
    assert.equal(store.tabIdFor("src/index.js"), "main-tab");
  } finally {
    delete globalThis.muxy;
  }
});

test("file changes only match the file in the folder they came from", async () => {
  const { same_file } = await import("../src/lib/files.js");
  const main_change = { path: `${MAIN}/src/index.js`, projectPath: MAIN, root: MAIN };
  const extra_change = { path: `${EXTRA_A}/src/index.js`, projectPath: MAIN, root: EXTRA_A };

  assert.equal(same_file(main_change, "src/index.js"), true);
  assert.equal(same_file(main_change, "src/index.js", EXTRA_A), false);
  assert.equal(same_file(extra_change, "src/index.js"), false);
  assert.equal(same_file(extra_change, "src/index.js", EXTRA_A), true);
  assert.equal(same_file(extra_change, "src/index.js", EXTRA_B), false);
  // A nested file with the same suffix is not the extra folder's top-level file.
  assert.equal(same_file({ ...extra_change, path: `${EXTRA_A}/pkg/src/index.js` }, "src/index.js", EXTRA_A), false);
  // Payloads without a root (older hosts) still count as main-folder changes.
  assert.equal(same_file({ path: `${MAIN}/src/index.js` }, "src/index.js"), true);
});

test("drafts are kept per folder and legacy drafts restore for the main folder", async () => {
  globalThis.localStorage = memory_storage();
  globalThis.muxy = {
    events: { subscribe: () => () => {} },
    exec: async () => ({ exitCode: 0, stdout: `${MAIN}\n` }),
  };
  try {
    // A draft written before multi-root: keyed by the bare relative path.
    localStorage.setItem(
      `muxy.files.draft:${MAIN}`,
      JSON.stringify({ "README.md": { content: "legacy edit", baseline: "legacy base", updatedAt: 1 } }),
    );
    const { clear_draft, read_draft, write_draft } = await import("../src/lib/draft-state.js");

    assert.deepEqual(await read_draft("README.md"), { content: "legacy edit", baseline: "legacy base" });
    assert.equal(await read_draft("README.md", EXTRA_A), null);

    await write_draft("src/index.js", "main edit", "main base");
    await write_draft("src/index.js", "extra edit", "extra base", EXTRA_A);
    assert.deepEqual(await read_draft("src/index.js"), { content: "main edit", baseline: "main base" });
    assert.deepEqual(await read_draft("src/index.js", EXTRA_A), { content: "extra edit", baseline: "extra base" });
    assert.equal(await read_draft("src/index.js", EXTRA_B), null);

    await clear_draft("src/index.js", EXTRA_A);
    assert.equal(await read_draft("src/index.js", EXTRA_A), null);
    assert.deepEqual(await read_draft("src/index.js"), { content: "main edit", baseline: "main base" });
  } finally {
    delete globalThis.muxy;
    delete globalThis.localStorage;
  }
});
