// Relative import keeps this module loadable by `node --test`.
import { file_key, normalize_root } from "./files.js";

const TAB_TYPE = "code-editor";

function tab_id_of(entry) {
  if (!entry || typeof entry !== "object") return null;
  const id = entry.tabID ?? entry.id ?? entry.tabInstanceID ?? entry.instanceID;
  return typeof id === "string" && id ? id : null;
}

function is_editor_entry(entry) {
  if (!entry || typeof entry !== "object") return false;
  const extId = entry.extensionID ?? entry.extension?.id;
  const type = entry.tabTypeID ?? entry.tabType ?? entry.extension?.tabType;
  return extId === muxy.extensionID && type === TAB_TYPE;
}

function file_of(entry) {
  let data = entry?.data ?? entry?.extension?.data;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      return null;
    }
  }
  const filePath = data && typeof data === "object" ? data.filePath : null;
  if (typeof filePath !== "string" || !filePath) return null;
  return { filePath, root: normalize_root(data.root) };
}

function is_active_entry(entry) {
  if (!entry || typeof entry !== "object") return false;
  return entry.active === true || entry.focused === true || entry.isActive === true || entry.selected === true;
}

export class OpenTabsStore {
  constructor() {
    this.byPath = new Map();
    this.byTab = new Map();
    this.disposers = [];
  }

  start() {
    this.disposers.push(
      muxy.events.subscribe("tab.created", (payload) => this.track(payload)),
      muxy.events.subscribe("tab.updated", (payload) => this.track(payload)),
      muxy.events.subscribe("tab.closed", (payload) => this.untrack(payload)),
    );
    void this.seed();
  }

  dispose() {
    for (const dispose of this.disposers) dispose?.();
    this.disposers = [];
    this.byPath.clear();
    this.byTab.clear();
  }

  async seed() {
    let tabs;
    try {
      tabs = await muxy.tabs.list();
    } catch {
      return;
    }
    if (!Array.isArray(tabs)) return;
    this.byPath.clear();
    this.byTab.clear();
    for (const entry of tabs) {
      if (!is_editor_entry(entry)) continue;
      this.set(file_of(entry), tab_id_of(entry));
    }
  }

  track(payload) {
    if (!is_editor_entry(payload)) return;
    this.set(file_of(payload), tab_id_of(payload));
  }

  untrack(payload) {
    const tabId = tab_id_of(payload);
    if (tabId) this.removeByTab(tabId);
  }

  // Tabs are keyed by root + relative path so the same path in two folders
  // never resolves to the other folder's tab.
  set(file, tabId) {
    if (!file || !tabId) return;
    const key = file_key(file.root, file.filePath);
    const prev = this.byTab.get(tabId);
    if (prev && prev.key !== key) this.byPath.delete(prev.key);
    const prevTab = this.byPath.get(key);
    if (prevTab && prevTab !== tabId) this.byTab.delete(prevTab);
    this.byPath.set(key, tabId);
    this.byTab.set(tabId, { key, filePath: file.filePath, root: file.root });
  }

  removeByTab(tabId) {
    const file = this.byTab.get(tabId);
    this.byTab.delete(tabId);
    if (file && this.byPath.get(file.key) === tabId) this.byPath.delete(file.key);
  }

  tabIdFor(filePath, root = null) {
    return this.byPath.get(file_key(root, filePath)) ?? null;
  }

  fileFor(tabId) {
    const file = this.byTab.get(tabId);
    return file ? { filePath: file.filePath, root: file.root } : null;
  }

  async resolveTabId(filePath, root = null) {
    await this.seed();
    return this.tabIdFor(filePath, root);
  }

  async resolveFile(tabId) {
    if (!tabId) return null;
    const known = this.fileFor(tabId);
    if (known) return known;
    await this.seed();
    return this.fileFor(tabId);
  }

  async activeFile() {
    let tabs;
    try {
      tabs = await muxy.tabs.list();
    } catch {
      return null;
    }
    if (!Array.isArray(tabs)) return null;
    for (const entry of tabs) {
      if (!is_editor_entry(entry) || !is_active_entry(entry)) continue;
      return file_of(entry);
    }
    return null;
  }
}
