import {
  basename,
  canonical_dir,
  change_root,
  copy_path,
  copy_paths,
  entry_to_rel,
  normalize_root,
  open_externally,
  open_in_editor,
  parent_dir,
  reveal_in_finder,
  reveal_paths,
  root_opts,
  strip_slash,
} from "@/lib/files";
import {
  create_file,
  create_folder,
  delete_paths,
  duplicate as duplicate_op,
  move_fs,
  rename_fs,
} from "@/lib/file-ops";
import { cls, h, icon_svg } from "@/lib/dom";
import { material_file_icon, material_folder_icon } from "@/lib/material-icon";
import { FOLDER_PATHS, icon_paths_for } from "@/lib/file-icon";
import { load_icon_theme, save_icon_theme, subscribe_icon_theme } from "@/lib/icon-theme";
import { load_tree_memory, save_tree_memory } from "@/lib/tree-memory";
import { worktree_root } from "@/lib/worktree-root";
import { publish_pointer_over_panel } from "@/lib/pointer-guard";
import { reconcile_children } from "@/lib/list-reconcile";
import { GitStatusStore } from "@/lib/git-status";
import { OpenTabsStore } from "@/lib/open-tabs";

const RECONCILE_DEBOUNCE_MS = 250;
// Expand all stops after this many folders, and lists this many at once, so a
// huge tree can't flood the bridge or the DOM.
const EXPAND_ALL_LIMIT = 500;
const EXPAND_ALL_BATCH = 32;

const GIT_STATUS_CLASS = {
  M: "file-tree-git-modified",
  R: "file-tree-git-modified",
  A: "file-tree-git-added",
  "?": "file-tree-git-added",
  D: "file-tree-git-deleted",
};

const GIT_STATUS_LABEL = {
  M: "Modified",
  R: "Renamed",
  A: "Added",
  "?": "Untracked",
  D: "Deleted",
};

const GIT_STATUS_GLYPH = {
  M: "M",
  R: "R",
  A: "A",
  "?": "U",
  D: "D",
};

function is_dir(path) {
  return path === "" || path.endsWith("/");
}

// Tree keys: main-folder nodes keep their bare relative path. Extra-folder nodes
// get one path-like leading segment, `\0<encoded root>/`, so parent_dir,
// basename and depth_of keep working and that prefix is the folder's own node.
function node_key(root, rel) {
  return root ? `\0${encodeURIComponent(root)}/${rel}` : rel;
}

function split_key(key) {
  if (!key.startsWith("\0")) return { root: null, rel: key };
  const slash = key.indexOf("/");
  return { root: decodeURIComponent(key.slice(1, slash)), rel: key.slice(slash + 1) };
}

// The main root ("") or an extra folder's top-level node: never renamed,
// deleted, duplicated or dragged.
function is_root_node(key) {
  return split_key(key).rel === "";
}

function display_name(key) {
  const { root, rel } = split_key(key);
  return rel === "" && root ? basename(root) : basename(key);
}

function group_by_root(keys) {
  const groups = new Map();
  for (const key of keys) {
    const { root, rel } = split_key(key);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(rel);
  }
  return groups;
}

// Relative paths are ambiguous across folders, so extra-folder paths copy absolute.
function copy_text(key) {
  const { root, rel } = split_key(key);
  return root ? `${root}/${strip_slash(rel)}` : rel;
}

// panel.opened payloads aren't strongly documented; accept the common shapes.
function panel_id_of(payload) {
  if (typeof payload === "string") return payload;
  if (payload && typeof payload === "object") return payload.panel ?? payload.id ?? payload.panelId ?? null;
  return null;
}

function focused_tab_id_of(payload) {
  if (typeof payload === "string") return payload;
  if (payload && typeof payload === "object") {
    const id = payload.tabID ?? payload.tabId ?? payload.id ?? payload.tabInstanceID ?? payload.instanceID;
    return typeof id === "string" && id ? id : null;
  }
  return null;
}

function block_ends_within(dirSegs, pathSegs, maxEnd) {
  if (dirSegs.length === 0) return true;
  for (let start = 0; start + dirSegs.length <= maxEnd; start++) {
    let matched = true;
    for (let i = 0; i < dirSegs.length; i++) {
      if (pathSegs[start + i] !== dirSegs[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

const NAME_COLLATOR = new Intl.Collator(undefined, { sensitivity: "base" });

function sorted_rels(entries) {
  return entries
    .map((entry) => entry_to_rel(entry))
    .sort((a, b) => {
      const ad = is_dir(a);
      const bd = is_dir(b);
      if (ad !== bd) return ad ? -1 : 1;
      return NAME_COLLATOR.compare(basename(a), basename(b));
    });
}

function chevron_icon(expanded) {
  return icon_svg([{ d: expanded ? "M6 9l6 6 6-6" : "M9 6l6 6-6 6" }]);
}

function depth_of(rel) {
  const trimmed = rel.endsWith("/") ? rel.slice(0, -1) : rel;
  return trimmed ? trimmed.split("/").length : 0;
}

function file_icon(kind, path, theme) {
  if (theme === "material") {
    return kind === "directory" ? material_folder_icon() : material_file_icon(path);
  }
  return icon_svg(kind === "directory" ? FOLDER_PATHS : icon_paths_for(path));
}

function toolbar_button(label, paths, onClick) {
  return h(
    "button",
    { class: "file-tree-toolbar-button", type: "button", title: label, "aria-label": label, onClick },
    icon_svg(paths),
  );
}

function path_after_rename(sourcePath, newName, isFolder) {
  const parent = parent_dir(sourcePath);
  return isFolder ? canonical_dir(`${parent}${newName}`) : `${parent}${newName}`;
}

function context_menu_actions(item, ops, selection) {
  const path = item.path;
  const multi = selection.length > 1 && selection.includes(path);
  if (multi) {
    return [
      { label: "Reveal in Finder", run: () => void ops.revealPaths(selection) },
      { label: "Copy Paths", run: () => void ops.copyPaths(selection) },
      { label: `Delete ${selection.length} items`, run: () => void ops.deletePaths(selection), critical: true },
    ];
  }

  const createDir = item.kind === "directory" ? path : parent_dir(path);
  const actions = [
    { label: "New File", run: () => void ops.createFile(createDir) },
    { label: "New Folder", run: () => void ops.createFolder(createDir) },
  ];

  if (!is_root_node(path)) {
    actions.push(
      { label: "Rename", run: () => ops.rename(path) },
      { label: "Duplicate", run: () => void ops.duplicate(path) },
      { label: "Reveal in Finder", run: () => void ops.reveal(path) },
      { label: "Copy Path", run: () => void ops.copyPath(path) },
      { label: "Open Externally", run: () => void ops.openExternally(path) },
      { label: "Delete", run: () => void ops.deletePaths([path]), critical: true },
    );
  } else {
    actions.push({ label: "Refresh", run: () => void ops.refresh() });
  }

  return actions;
}

function create_context_menu(item, ops, close, selection = []) {
  const actions = context_menu_actions(item, ops, selection);
  return h(
    "div",
    { class: "ctx-menu ctx-menu-floating", dataset: { fileTreeContextMenuRoot: "true" } },
    actions.map((action, index) =>
      h(
        "button",
        {
          type: "button",
          class: cls("ctx-item", action.critical && "ctx-item-critical", action.critical && index > 0 && "ctx-item-spaced"),
          onClick: () => {
            close();
            action.run();
          },
        },
        action.label,
      ),
    ),
  );
}

export class FilesPanelApp {
  constructor(root) {
    this.root = root;
    this.entries = new Map();
    this.children = new Map();
    this.loadedDirs = new Set();
    this.expandedDirs = new Set();
    this.selectedPath = null;
    this.selectedPaths = new Set();
    this.anchorPath = null;
    this.worktreeRoot = null;
    // Node keys of the active project's extra folders, in project order.
    this.extraRoots = [];
    // The project folder's own root row, which collapses its whole tree.
    this.mainCollapsed = false;
    this.mainRow = null;
    this.dropTarget = null;
    this.renameState = null;
    this.activeRenameInput = null;
    this.pendingDirs = new Set();
    this.reconcileTimer = null;
    this.contextMenu = null;
    this.contextDisposers = [];
    this.disposers = [];
    this.gitStatus = new GitStatusStore();
    this.openTabs = new OpenTabsStore();
    this.dirtyFilter = false;
    this.iconTheme = load_icon_theme();
    // Keyboard navigation: `visiblePaths` is the rendered rows in display
    // order, `rowElements` maps each path to its row node so selection can be
    // updated without a full re-render.
    this.visiblePaths = [];
    this.rowElements = new Map();
    // Row nodes are reused across renders, keyed by path and invalidated by a
    // signature of everything baked into the node.
    this.rowCache = new Map();
    this.renderedSelection = new Set();
    this.renderOrder = null;
    this.typeahead = { buffer: "", timer: null };
    this.didInitialFocus = false;

    this.ops = {
      createFile: (parentRel = "") => this.createFile(parentRel),
      createFolder: (parentRel = "") => this.createFolder(parentRel),
      deletePaths: (rels) => this.deletePaths(rels),
      duplicate: (rel) => this.duplicate(rel),
      rename: (rel) => this.startRename(rel),
      reveal: (key) => reveal_in_finder(split_key(key).rel, split_key(key).root),
      revealPaths: (keys) =>
        Promise.all(Array.from(group_by_root(keys), ([root, rels]) => reveal_paths(rels, root))),
      openExternally: (key) => open_externally(split_key(key).rel, split_key(key).root),
      copyPath: (key) => copy_path(copy_text(key)),
      copyPaths: (rels) => this.copyPaths(rels),
      openInEditor: (rel) => this.openFile(rel),
      refresh: () => this.loadRoot(),
    };
  }

  async openFile(key) {
    const { root, rel } = split_key(key);
    const tabId = await this.openTabs.resolveTabId(rel, root);
    return open_in_editor(rel, root, tabId);
  }

  // Tree key for an open tab's file, or null when its folder isn't in this tree.
  keyForFile(file) {
    if (!file) return null;
    if (!file.root) return file.filePath;
    return this.extraRoots.includes(node_key(file.root, "")) ? node_key(file.root, file.filePath) : null;
  }

  async revealActiveTab(payload) {
    const tabId = focused_tab_id_of(payload);
    if (!tabId) return;
    const key = this.keyForFile(await this.openTabs.resolveFile(tabId));
    if (!key) return;
    await this.revealFile(key);
  }

  async revealFile(rel) {
    if (!rel || this.dirtyFilter) return;
    const ancestors = [];
    let parent = parent_dir(rel);
    while (parent !== "") {
      ancestors.unshift(parent);
      parent = parent_dir(parent);
    }
    for (const dir of ancestors) {
      await this.ensureLoaded(parent_dir(dir));
      if (!this.entries.has(dir)) return;
      this.expandedDirs.add(dir);
      await this.ensureLoaded(dir);
    }
    if (!this.entries.has(rel)) return;
    this.setSelection(rel);
    this.render();
    this.persistMemory();
    const el = this.rowElements.get(rel);
    if (el) el.scrollIntoView({ block: "nearest" });
  }

  start() {
    this.filterBar = h("div", { class: "file-tree-filter-bar", hidden: true });
    const toolbar = h(
      "div",
      { class: "file-tree-toolbar" },
      toolbar_button("Expand all", [{ d: "M7 6l5 5 5-5" }, { d: "M7 13l5 5 5-5" }], () => void this.expandAll()),
      toolbar_button("Collapse all", [{ d: "M7 11l5-5 5 5" }, { d: "M7 18l5-5 5 5" }], () => this.collapseAll()),
    );
    const panel = h("div", { class: "files-panel" }, toolbar, this.filterBar, h("div", { class: "file-tree-wrap" }));
    this.root.replaceChildren(panel);
    this.wrap = panel.querySelector(".file-tree-wrap");
    this.list = h("div", {
      class: "file-tree-list",
      role: "tree",
      // Focusable so the tree can be driven entirely from the keyboard. The
      // active row is tracked via aria-activedescendant while DOM focus stays
      // on this container (which survives the full re-render on each change).
      tabindex: 0,
      "aria-label": "File tree",
      onKeyDown: (event) => this.onKeyDown(event),
      onFocus: () => this.onListFocus(),
      onClick: (event) => {
        if (event.target !== this.list) return;
        this.clearSelection();
      },
      onContextMenu: (event) => {
        event.preventDefault();
        this.showContextMenu({ kind: "directory", name: "Root", path: "" }, event.clientX, event.clientY);
      },
      onDragOver: (event) => {
        event.preventDefault();
        this.dropTarget = "";
      },
      onDrop: (event) => this.dropPaths(event, ""),
    });
    this.wrap.appendChild(this.list);

    this.openTabs.start();

    // Take keyboard focus whenever Muxy hands this panel focus (e.g. after the
    // toggle-files shortcut) so arrow keys work without a click first.
    this.handleWindowFocus = () => this.focusList();
    window.addEventListener("focus", this.handleWindowFocus);

    this.pointerOver = false;
    this.handlePointerMove = () => {
      if (this.pointerOver) return;
      this.pointerOver = true;
      publish_pointer_over_panel(true);
    };
    this.handlePointerLeave = () => {
      if (!this.pointerOver) return;
      this.pointerOver = false;
      publish_pointer_over_panel(false);
    };
    document.addEventListener("mousemove", this.handlePointerMove);
    document.documentElement.addEventListener("mouseleave", this.handlePointerLeave);
    window.addEventListener("pagehide", this.handlePointerLeave);

    document.addEventListener("contextmenu", this.preventNativeContextMenu);
    this.disposers.push(
      () => this.openTabs.dispose(),
      this.gitStatus.subscribe(() => this.onGitStatusChange()),
      muxy.events.subscribe("worktree.switched", () => void this.loadRoot()),
      muxy.events.subscribe("project.switched", () => void this.loadRoot()),
      muxy.events.subscribe("projects.changed", () => void this.refreshFolders()),
      // When our panel is (re)opened, pull keyboard focus into the tree so it's
      // navigable immediately without a click.
      muxy.events.subscribe("panel.opened", (payload) => {
        if (panel_id_of(payload) === "files") requestAnimationFrame(() => this.focusList());
      }),
      muxy.events.subscribe("tab.focused", (payload) => {
        void this.revealActiveTab(payload);
      }),
      muxy.events.subscribe("file.changed", (payload) => {
        const root = change_root(payload);
        const extra = root && this.extraRoots.includes(node_key(root, "")) ? root : null;
        this.scheduleReconcile(payload, extra);
        // Git status covers the main folder only.
        if (!extra) this.gitStatus.scheduleRefresh(RECONCILE_DEBOUNCE_MS);
      }),
      muxy.events.subscribe("command.files-new-file", () => void this.createFile("")),
      muxy.events.subscribe("command.files-new-folder", () => void this.createFolder("")),
      muxy.events.subscribe("command.files-refresh", () => void this.loadRoot()),
      muxy.events.subscribe("command.files-toggle-dirty-filter", () => this.toggleDirtyFilter()),
      muxy.events.subscribe("command.files-toggle-icon-theme", () => this.toggleIconTheme()),
      subscribe_icon_theme((theme) => {
        if (theme === this.iconTheme) return;
        this.iconTheme = theme;
        this.render();
      }),
      () => this.gitStatus.dispose(),
      () => document.removeEventListener("contextmenu", this.preventNativeContextMenu),
      () => window.removeEventListener("focus", this.handleWindowFocus),
      () => {
        document.removeEventListener("mousemove", this.handlePointerMove);
        document.documentElement.removeEventListener("mouseleave", this.handlePointerLeave);
        window.removeEventListener("pagehide", this.handlePointerLeave);
        this.handlePointerLeave();
      },
    );

    void this.loadRoot();
    void this.gitStatus.refresh();
  }

  preventNativeContextMenu = (event) => {
    if (event.target instanceof HTMLElement && event.target.closest("[data-file-tree-context-menu-root='true']")) return;
    event.preventDefault();
  };

  dispose() {
    this.closeContextMenu();
    for (const dispose of this.disposers) dispose?.();
    this.disposers = [];
    if (this.reconcileTimer !== null) clearTimeout(this.reconcileTimer);
    if (this.typeahead.timer !== null) clearTimeout(this.typeahead.timer);
  }

  recordChildren(dirRel, entries) {
    const { root } = split_key(dirRel);
    const byRel = new Map(entries.map((entry) => [node_key(root, entry_to_rel(entry)), entry]));
    const rels = sorted_rels(entries).map((rel) => node_key(root, rel));
    const previous = this.children.get(dirRel) ?? [];
    const nextSet = new Set(rels);
    for (const oldPath of previous) {
      if (!nextSet.has(oldPath)) this.removeSubtree(oldPath);
    }
    for (const rel of rels) {
      const entry = byRel.get(rel);
      this.entries.set(rel, {
        path: rel,
        kind: rel.endsWith("/") ? "directory" : "file",
        isIgnored: Boolean(entry?.isIgnored),
      });
    }
    this.children.set(dirRel, rels);
    this.loadedDirs.add(dirRel);
  }

  removeSubtree(path) {
    if (path.endsWith("/")) {
      for (const child of this.children.get(path) ?? []) this.removeSubtree(child);
      this.children.delete(path);
      this.loadedDirs.delete(path);
      this.expandedDirs.delete(path);
    }
    this.entries.delete(path);
    if (this.selectedPath === path) this.selectedPath = null;
    this.selectedPaths.delete(path);
    if (this.anchorPath === path) this.anchorPath = null;
  }

  async loadRoot() {
    this.entries.clear();
    this.children.clear();
    this.loadedDirs.clear();
    this.expandedDirs.clear();
    this.mainCollapsed = false;
    this.setSelection(null);
    this.closeContextMenu();
    void this.gitStatus.refresh();
    const rootPromise = this.resolveRoot();
    const foldersPromise = this.loadFolders();
    try {
      const entries = await muxy.files.list("");
      this.recordChildren("", entries);
    } catch (err) {
      void muxy
        .toast({
          title: "Files",
          body: err instanceof Error ? err.message : String(err),
          variant: "error",
        })
        .catch(() => undefined);
      this.children.set("", []);
    }
    this.extraRoots = [];
    this.render();
    this.setExtraRoots(await foldersPromise);
    this.render();
    const [root] = await Promise.all([rootPromise, this.restoreMemory()]);
    this.worktreeRoot = root;
    this.render();
    this.maybeInitialFocus();
    void this.revealActiveOnLoad();
  }

  async revealActiveOnLoad() {
    const key = this.keyForFile(await this.openTabs.activeFile());
    if (key) await this.revealFile(key);
  }

  async loadFolders() {
    try {
      const projects = await muxy.projects.list();
      const active = Array.isArray(projects) ? projects.find((project) => project?.isActive) : null;
      const folders = Array.isArray(active?.folders) ? active.folders : [];
      return Array.from(new Set(folders.map(normalize_root).filter(Boolean)));
    } catch {
      return [];
    }
  }

  // Extra folders start collapsed and list nothing until expanded, so large
  // folders cost nothing up front.
  setExtraRoots(folders) {
    const next = folders.map((folder) => node_key(folder, ""));
    for (const key of this.extraRoots) {
      if (!next.includes(key)) this.removeSubtree(key);
    }
    for (const key of next) {
      if (!this.entries.has(key)) this.entries.set(key, { path: key, kind: "directory", isIgnored: false });
    }
    this.extraRoots = next;
  }

  async refreshFolders() {
    const folders = await this.loadFolders();
    const next = folders.map((folder) => node_key(folder, ""));
    if (next.length === this.extraRoots.length && next.every((key, i) => key === this.extraRoots[i])) return;
    this.setExtraRoots(folders);
    this.render();
  }

  listDir(dirKey) {
    const { root, rel } = split_key(dirKey);
    return muxy.files.list(rel, root_opts(root));
  }

  async restoreMemory() {
    const { expanded, selected, collapsed } = await load_tree_memory();
    this.mainCollapsed = collapsed;
    const byDepth = new Map();
    for (const dir of expanded) {
      const depth = depth_of(dir);
      if (!byDepth.has(depth)) byDepth.set(depth, []);
      byDepth.get(depth).push(dir);
    }
    const depths = Array.from(byDepth.keys()).sort((a, b) => a - b);
    for (const depth of depths) {
      const dirs = byDepth.get(depth).filter((dir) => {
        const parent = parent_dir(dir);
        if (parent !== "" && !this.expandedDirs.has(parent)) return false;
        return this.entries.has(dir);
      });
      await Promise.all(
        dirs.map(async (dir) => {
          this.expandedDirs.add(dir);
          await this.ensureLoaded(dir);
        }),
      );
    }
    if (selected && this.entries.has(selected)) this.setSelection(selected);
  }

  persistMemory() {
    void save_tree_memory(this.expandedDirs, this.selectedPath, this.mainCollapsed);
  }

  async loadChildren(dirRel) {
    try {
      const entries = await this.listDir(dirRel);
      this.recordChildren(dirRel, entries);
    } catch {
      return;
    }
  }

  async ensureLoaded(dirRel) {
    if (!this.loadedDirs.has(dirRel)) await this.loadChildren(dirRel);
  }

  async refreshDir(dirRel) {
    if (!this.loadedDirs.has(dirRel)) return;
    try {
      const entries = await this.listDir(dirRel);
      this.recordChildren(dirRel, entries);
    } catch {
      return;
    }
  }

  async toggleDirtyFilter() {
    this.dirtyFilter = !this.dirtyFilter;
    if (this.dirtyFilter) {
      await this.gitStatus.refresh();
      await this.ensureDirtyLoaded();
    }
    this.render();
  }

  toggleIconTheme() {
    save_icon_theme(this.iconTheme === "material" ? "stroke" : "material");
  }

  onGitStatusChange() {
    if (this.dirtyFilter) {
      void this.ensureDirtyLoaded().then(() => this.render());
      return;
    }
    this.render();
  }

  async ensureDirtyLoaded() {
    const dirs = new Set();
    for (const filePath of this.gitStatus.files.keys()) {
      let parent = parent_dir(filePath);
      while (parent !== "") {
        dirs.add(parent);
        parent = parent_dir(parent);
      }
    }
    await Promise.all(
      Array.from(dirs, async (dir) => {
        await this.ensureLoaded(dir);
        this.expandedDirs.add(dir);
      }),
    );
  }

  // Extra folders have no git status, so they show no markers and the
  // changed-files filter hides them.
  gitStatusFor(path, directory) {
    return path.startsWith("\0") ? null : this.gitStatus.statusFor(path, directory);
  }

  isVisibleInFilter(path, directory) {
    return Boolean(this.gitStatusFor(path, directory));
  }

  renderFilterBar() {
    if (!this.filterBar) return;
    this.filterBar.hidden = !this.dirtyFilter;
    if (!this.dirtyFilter) {
      this.filterBar.replaceChildren();
      return;
    }
    this.filterBar.replaceChildren(
      h("span", { class: "file-tree-filter-label" }, "Changed files only"),
      h(
        "button",
        {
          type: "button",
          class: "file-tree-filter-clear",
          onClick: () => void this.toggleDirtyFilter(),
        },
        "Clear",
      ),
    );
  }

  render() {
    if (!this.list) return;
    const active = this.activeRenameInput;
    if (active && document.activeElement === active) {
      this.renameSelection = { start: active.selectionStart, end: active.selectionEnd };
    } else {
      this.renameSelection = null;
    }
    this.reRendering = true;
    try {
      this.renderTree();
    } finally {
      this.reRendering = false;
    }
    this.focusRenameInput();
  }

  renderTree() {
    if (!this.list) return;
    this.renderFilterBar();
    this.visiblePaths = [];
    this.rowElements = new Map();
    this.renderOrder = [];
    const rootChildren = this.children.get("") ?? [];
    this.renderOrder.push(this.renderMainRow());
    if (this.mainCollapsed) {
      // The project folder's tree is hidden under its root row.
    } else if (rootChildren.length === 0) {
      this.renderOrder.push(h("div", { class: "files-status" }, "No files"));
    } else if (this.dirtyFilter) {
      const visible = rootChildren.filter((path) => this.isVisibleInFilter(path, is_dir(path)));
      if (visible.length === 0) {
        const message = this.gitStatus.available ? "No changed files" : "No git changes";
        this.renderOrder.push(h("div", { class: "files-status" }, message));
      } else {
        for (const path of visible) this.renderRow(path, 1);
      }
    } else {
      for (const path of rootChildren) this.renderRow(path, 1);
    }
    if (!this.dirtyFilter) {
      for (const key of this.extraRoots) this.renderRow(key, 0);
    }
    // Rows that didn't change keep their DOM node: rebuilding every row broke
    // clicks, since a render landing between mousedown and mouseup destroyed
    // the row and no click event was ever dispatched.
    reconcile_children(this.list, this.renderOrder);
    this.renderOrder = null;
    for (const path of this.rowCache.keys()) {
      if (!this.rowElements.has(path)) this.rowCache.delete(path);
    }
    this.renderedSelection = new Set(this.selectedPaths);
    this.syncActiveDescendant();
  }

  // The project folder's root row. It isn't a tree node, since "" is the
  // empty selection, so keyboard navigation skips it.
  renderMainRow() {
    const name = this.worktreeRoot ? basename(this.worktreeRoot) : "Project";
    const expanded = !this.mainCollapsed;
    const signature = [name, expanded ? 1 : 0, this.iconTheme].join("|");
    if (this.mainRow?.signature === signature) return this.mainRow.element;
    const toggle = (event) => {
      event.stopPropagation();
      this.mainCollapsed = !this.mainCollapsed;
      this.render();
      this.persistMemory();
      this.list?.focus({ preventScroll: true });
    };
    const element = h(
      "div",
      {
        class: "file-tree-row file-tree-root-row",
        role: "treeitem",
        "aria-expanded": expanded,
        onClick: toggle,
        onContextMenu: (event) => {
          event.preventDefault();
          event.stopPropagation();
          this.showContextMenu({ kind: "directory", name: "Root", path: "" }, event.clientX, event.clientY);
        },
        onDragOver: (event) => {
          event.preventDefault();
          this.dropTarget = "";
        },
        onDrop: (event) => this.dropPaths(event, ""),
      },
      // Matches the indent span every tree row has, so the roots line up.
      h("span", { class: "file-tree-indent", style: { width: "0px" } }),
      h(
        "button",
        {
          class: "file-tree-disclosure",
          type: "button",
          "aria-label": expanded ? "Collapse folder" : "Expand folder",
          onClick: toggle,
        },
        chevron_icon(expanded),
      ),
      h("span", { class: "file-tree-kind-icon" }, file_icon("directory", "", this.iconTheme)),
      h("span", { class: "file-tree-name", title: this.worktreeRoot ?? "" }, name),
    );
    this.mainRow = { element, signature };
    return element;
  }

  // Opens every folder, breadth first, skipping ignored ones like
  // node_modules, up to EXPAND_ALL_LIMIT folders.
  async expandAll() {
    if (this.dirtyFilter) return;
    this.mainCollapsed = false;
    const queue = ["", ...this.extraRoots];
    let visited = 0;
    while (queue.length > 0 && visited < EXPAND_ALL_LIMIT) {
      const batch = queue.splice(0, Math.min(EXPAND_ALL_BATCH, EXPAND_ALL_LIMIT - visited));
      visited += batch.length;
      await Promise.all(
        batch.map(async (dir) => {
          if (dir !== "") this.expandedDirs.add(dir);
          await this.ensureLoaded(dir);
        }),
      );
      for (const dir of batch) {
        for (const child of this.children.get(dir) ?? []) {
          if (is_dir(child) && !this.entries.get(child)?.isIgnored) queue.push(child);
        }
      }
    }
    this.render();
    this.persistMemory();
    if (queue.length > 0) {
      void muxy
        .toast({ title: "Files", body: `Expanded the first ${EXPAND_ALL_LIMIT} folders`, variant: "info" })
        .catch(() => undefined);
    }
  }

  // Folds every folder, the project's own root included, down to the root rows.
  collapseAll() {
    this.mainCollapsed = true;
    this.expandedDirs.clear();
    this.render();
    this.persistMemory();
  }

  rowSignature(depth, entry, directory, expanded, renaming, gitStatus) {
    return [
      depth,
      directory ? 1 : 0,
      expanded ? 1 : 0,
      renaming ? 1 : 0,
      gitStatus ?? "",
      entry.isIgnored ? 1 : 0,
      this.iconTheme,
    ].join("|");
  }

  renderRow(path, depth) {
    const entry = this.entries.get(path);
    if (!entry) return;
    const directory = entry.kind === "directory";
    const expanded = directory && this.expandedDirs.has(path);
    const renaming = this.renameState?.path === path;
    const gitStatus = this.gitStatusFor(path, directory);
    const signature = this.rowSignature(depth, entry, directory, expanded, renaming, gitStatus);
    const cached = this.rowCache.get(path);
    // A row mid-rename is always rebuilt so it re-adopts the live input.
    const row =
      cached && cached.signature === signature && !renaming
        ? cached.element
        : this.buildRow(path, depth, entry, directory, expanded, renaming, gitStatus);
    this.rowCache.set(path, { element: row, signature });

    const id = `ft-row-${this.visiblePaths.length}`;
    if (row.id !== id) row.id = id;
    const selected = this.selectedPaths.has(path);
    row.classList.toggle("file-tree-row-selected", selected);
    row.setAttribute("aria-selected", String(selected));
    row.classList.toggle("file-tree-row-drop", this.dropTarget === path);

    this.rowElements.set(path, row);
    this.visiblePaths.push(path);
    this.renderOrder.push(row);

    if (directory && expanded) {
      for (const child of this.children.get(path) ?? []) {
        if (this.dirtyFilter && !this.isVisibleInFilter(child, is_dir(child))) continue;
        this.renderRow(child, depth + 1);
      }
    }
  }

  buildRow(path, depth, entry, directory, expanded, renaming, gitStatus) {
    const row = h(
      "div",
      {
        class: cls(
          "file-tree-row",
          entry.isIgnored && "file-tree-row-ignored",
          gitStatus && GIT_STATUS_CLASS[gitStatus],
          gitStatus && directory && "file-tree-row-git-folder",
          is_root_node(path) && "file-tree-root-row",
        ),
        role: "treeitem",
        "aria-expanded": directory ? expanded : undefined,
        draggable: !renaming && !is_root_node(path),
        dataset: { path, type: "item", itemType: directory ? "directory" : "file", itemPath: path },
        onClick: (event) => {
          event.stopPropagation();
          if (renaming) return;
          if (event.metaKey || event.ctrlKey) {
            this.toggleSelection(path);
            this.applySelection();
            this.persistMemory();
            this.list?.focus({ preventScroll: true });
            return;
          }
          if (event.shiftKey) {
            this.selectRange(path);
            this.applySelection();
            this.persistMemory();
            this.list?.focus({ preventScroll: true });
            return;
          }
          void this.activatePath(path);
          this.list?.focus({ preventScroll: true });
        },
        onContextMenu: (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!this.selectedPaths.has(path)) {
            this.setSelection(path);
            this.applySelection();
          }
          this.showContextMenu({ kind: entry.kind, name: basename(path), path }, event.clientX, event.clientY);
        },
        onDragStart: (event) => {
          if (!event.dataTransfer) return;
          const dragging = (
            this.selectedPaths.has(path) && this.selectedPaths.size > 1 ? this.selectionList() : [path]
          ).filter((key) => !is_root_node(key));
          event.dataTransfer.setData("application/x-muxy-path", dragging.join("\n"));
          const abses = dragging.map((rel) => this.abs_path(rel)).filter(Boolean);
          if (abses.length === dragging.length) {
            event.dataTransfer.setData("text/uri-list", abses.map((abs) => this.file_url(abs)).join("\r\n"));
            event.dataTransfer.setData("text/plain", abses.join("\n"));
          } else {
            event.dataTransfer.setData("text/plain", dragging.join("\n"));
          }
        },
        onDragOver: (event) => {
          if (!directory) return;
          event.preventDefault();
          this.dropTarget = path;
          row.classList.add("file-tree-row-drop");
        },
        onDragLeave: () => {
          if (this.dropTarget === path) this.dropTarget = null;
          row.classList.remove("file-tree-row-drop");
        },
        onDrop: (event) => this.dropPaths(event, directory ? path : parent_dir(path)),
      },
      h("span", { class: "file-tree-indent", style: { width: `${depth * 10}px` } }),
      directory
        ? h(
            "button",
            {
              class: "file-tree-disclosure",
              type: "button",
              "aria-label": expanded ? "Collapse folder" : "Expand folder",
              onClick: (event) => {
                event.stopPropagation();
                this.setSelection(path);
                void this.toggleDirectory(path);
                this.list?.focus({ preventScroll: true });
              },
            },
            chevron_icon(expanded),
          )
        : h("span", { class: "file-tree-disclosure file-tree-disclosure-placeholder" }),
      h("span", { class: "file-tree-kind-icon" }, file_icon(entry.kind, path, this.iconTheme)),
      renaming
        ? this.renderRenameInput(path, directory)
        : h("span", { class: "file-tree-name", title: split_key(path).rel || split_key(path).root }, display_name(path)),
      !renaming && !directory && gitStatus
        ? h("span", { class: "file-tree-git-mark", title: GIT_STATUS_LABEL[gitStatus] }, GIT_STATUS_GLYPH[gitStatus])
        : null,
    );
    return row;
  }

  renderRenameInput(path, directory) {
    if (this.activeRenameInput && this.renameState?.path === path) {
      return this.activeRenameInput;
    }
    const input = h("input", {
      class: "file-tree-rename-input",
      type: "text",
      value: basename(path),
      spellcheck: "false",
      autocapitalize: "off",
      autocomplete: "off",
      autocorrect: "off",
      onClick: (event) => event.stopPropagation(),
      onKeyDown: (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void this.commitRename(path, input.value, directory);
        } else if (event.key === "Escape") {
          event.preventDefault();
          void this.cancelRename();
        }
      },
      onBlur: () => {
        if (this.reRendering) return;
        void this.commitRename(path, input.value, directory);
      },
    });
    this.activeRenameInput = input;
    this.pendingRenameInput = input;
    return input;
  }

  focusRenameInput() {
    const fresh = this.pendingRenameInput;
    this.pendingRenameInput = null;
    if (fresh) {
      requestAnimationFrame(() => {
        fresh.focus();
        fresh.select();
      });
      return;
    }
    const restore = this.renameSelection;
    const input = this.activeRenameInput;
    this.renameSelection = null;
    if (!restore || !input) return;
    requestAnimationFrame(() => {
      if (document.activeElement === input) return;
      input.focus();
      const len = input.value.length;
      const start = restore.start ?? len;
      const end = restore.end ?? len;
      input.setSelectionRange(Math.min(start, len), Math.min(end, len));
    });
  }

  async activatePath(path) {
    this.setSelection(path);
    const entry = this.entries.get(path);
    if (!entry) return;
    if (entry.kind === "directory") {
      await this.toggleDirectory(path);
      return;
    }
    this.applySelection();
    this.persistMemory();
    void this.openFile(path);
  }

  async toggleDirectory(path) {
    if (this.expandedDirs.has(path)) {
      this.expandedDirs.delete(path);
      this.render();
      this.persistMemory();
      return;
    }
    this.expandedDirs.add(path);
    await this.ensureLoaded(path);
    this.render();
    this.persistMemory();
  }

  setSelection(path, { anchor = true } = {}) {
    this.selectedPath = path;
    this.selectedPaths = path ? new Set([path]) : new Set();
    if (anchor) this.anchorPath = path;
  }

  clearSelection() {
    if (!this.selectedPath && this.selectedPaths.size === 0) return;
    this.setSelection(null);
    this.applySelection();
    this.persistMemory();
  }

  toggleSelection(path) {
    if (!path) return;
    if (this.selectedPaths.has(path) && this.selectedPaths.size > 1) {
      this.selectedPaths.delete(path);
      if (this.selectedPath === path) this.selectedPath = this.lastSelected();
    } else {
      this.selectedPaths.add(path);
      this.selectedPath = path;
    }
    this.anchorPath = path;
  }

  selectRange(path) {
    const paths = this.visiblePaths;
    const anchor = this.anchorPath ?? this.selectedPath ?? path;
    const from = paths.indexOf(anchor);
    const to = paths.indexOf(path);
    if (from === -1 || to === -1) {
      this.setSelection(path);
      return;
    }
    const [lo, hi] = from <= to ? [from, to] : [to, from];
    this.selectedPaths = new Set(paths.slice(lo, hi + 1));
    this.selectedPath = path;
  }

  lastSelected() {
    for (let i = this.visiblePaths.length - 1; i >= 0; i -= 1) {
      if (this.selectedPaths.has(this.visiblePaths[i])) return this.visiblePaths[i];
    }
    return null;
  }

  selectionList() {
    return this.visiblePaths.filter((path) => this.selectedPaths.has(path));
  }

  async copyPaths(keys) {
    await copy_paths(keys.map(copy_text));
  }

  // ---- Keyboard navigation -------------------------------------------------

  applySelection() {
    const next = this.selectedPaths;
    const previous = this.renderedSelection;
    for (const path of previous) {
      if (next.has(path)) continue;
      const el = this.rowElements.get(path);
      if (!el) continue;
      el.classList.remove("file-tree-row-selected");
      el.setAttribute("aria-selected", "false");
    }
    for (const path of next) {
      if (previous.has(path)) continue;
      const el = this.rowElements.get(path);
      if (!el) continue;
      el.classList.add("file-tree-row-selected");
      el.setAttribute("aria-selected", "true");
    }
    this.renderedSelection = new Set(next);
    this.syncActiveDescendant();
  }

  syncActiveDescendant() {
    if (!this.list) return;
    const el = this.selectedPath ? this.rowElements.get(this.selectedPath) : null;
    if (el) this.list.setAttribute("aria-activedescendant", el.id);
    else this.list.removeAttribute("aria-activedescendant");
  }

  moveSelection(path, { reveal = true, extend = false } = {}) {
    if (!path || !this.rowElements.has(path)) return;
    let next;
    if (extend) {
      const paths = this.visiblePaths;
      const anchor = this.anchorPath ?? this.selectedPath ?? path;
      const from = paths.indexOf(anchor);
      const to = paths.indexOf(path);
      if (from === -1 || to === -1) {
        next = new Set([path]);
        this.anchorPath = path;
      } else {
        const [lo, hi] = from <= to ? [from, to] : [to, from];
        next = new Set(paths.slice(lo, hi + 1));
      }
    } else {
      next = new Set([path]);
      this.anchorPath = path;
    }
    this.selectedPaths = next;
    this.selectedPath = path;
    this.applySelection();
    const el = this.rowElements.get(path);
    if (reveal) el.scrollIntoView({ block: "nearest" });
    this.persistMemory();
  }

  focusList() {
    if (!this.list || this.renameState) return;
    // Don't steal focus from a field the user is typing in (e.g. a rename).
    const active = document.activeElement;
    if (
      active &&
      active !== this.list &&
      (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)
    ) {
      return;
    }
    try {
      this.list.focus({ preventScroll: true });
    } catch {
      /* focus can throw if the element is detached; ignore */
    }
  }

  maybeInitialFocus() {
    if (this.didInitialFocus) return;
    this.didInitialFocus = true;
    this.focusList();
  }

  // When the tree gains focus with nothing selected, highlight the first row
  // so arrow keys have a starting point.
  onListFocus() {
    if (this.selectedPath && this.rowElements.has(this.selectedPath)) return;
    if (this.visiblePaths.length > 0) this.moveSelection(this.visiblePaths[0], { reveal: false });
  }

  onKeyDown(event) {
    // Rename input and context menu own their own keys.
    if (this.renameState || this.contextMenu) return;
    // Leave app-level shortcuts (cmd/ctrl/alt combos) to Muxy.
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    const paths = this.visiblePaths;
    if (paths.length === 0) return;
    const idx = this.selectedPath ? paths.indexOf(this.selectedPath) : -1;
    const extend = event.shiftKey;

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        this.moveSelection(paths[idx < 0 ? 0 : Math.min(idx + 1, paths.length - 1)], { extend });
        return;
      case "ArrowUp":
        event.preventDefault();
        this.moveSelection(paths[idx < 0 ? paths.length - 1 : Math.max(idx - 1, 0)], { extend });
        return;
      case "ArrowRight":
        event.preventDefault();
        this.navigateRight(idx);
        return;
      case "ArrowLeft":
        event.preventDefault();
        this.navigateLeft(idx);
        return;
      case "Home":
        event.preventDefault();
        this.moveSelection(paths[0]);
        return;
      case "End":
        event.preventDefault();
        this.moveSelection(paths[paths.length - 1]);
        return;
      case "Enter":
      case " ":
        if (idx < 0) return;
        event.preventDefault();
        void this.activatePath(paths[idx]);
        return;
      case "F2":
        if (idx < 0 || is_root_node(paths[idx])) return;
        event.preventDefault();
        this.startRename(paths[idx]);
        return;
      case "Delete":
      case "Backspace": {
        const targets = this.selectionList().filter((path) => !is_root_node(path));
        if (targets.length === 0) return;
        event.preventDefault();
        void this.deletePaths(targets);
        return;
      }
      case "Escape":
        if (this.selectedPaths.size > 1) {
          event.preventDefault();
          this.setSelection(this.selectedPath);
          this.applySelection();
        }
        return;
      default:
        this.handleTypeahead(event);
    }
  }

  navigateRight(idx) {
    const paths = this.visiblePaths;
    if (idx < 0) {
      this.moveSelection(paths[0]);
      return;
    }
    const path = paths[idx];
    const entry = this.entries.get(path);
    if (!entry || entry.kind !== "directory") return;
    const expanded = this.expandedDirs.has(path);
    if (!expanded) {
      this.setSelection(path);
      void this.toggleDirectory(path);
      return;
    }
    // Already open: step into the first child if the folder has visible ones.
    const next = paths[idx + 1];
    if (next && depth_of(next) > depth_of(path)) this.moveSelection(next);
  }

  navigateLeft(idx) {
    const paths = this.visiblePaths;
    if (idx < 0) {
      this.moveSelection(paths[0]);
      return;
    }
    const path = paths[idx];
    const entry = this.entries.get(path);
    const expanded = entry?.kind === "directory" && this.expandedDirs.has(path);
    if (expanded) {
      this.setSelection(path);
      void this.toggleDirectory(path);
      return;
    }
    // Otherwise jump to the parent folder when it's visible in the tree.
    const parent = parent_dir(path);
    if (parent && this.rowElements.has(parent)) this.moveSelection(parent);
  }

  handleTypeahead(event) {
    const ch = event.key;
    if (ch.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return;
    if (!/\S/.test(ch)) return;
    event.preventDefault();
    if (this.typeahead.timer !== null) clearTimeout(this.typeahead.timer);
    this.typeahead.buffer += ch.toLowerCase();
    this.typeahead.timer = setTimeout(() => {
      this.typeahead.buffer = "";
      this.typeahead.timer = null;
    }, 600);

    const paths = this.visiblePaths;
    const start = this.selectedPath ? paths.indexOf(this.selectedPath) : -1;
    const buffer = this.typeahead.buffer;
    for (let i = 1; i <= paths.length; i += 1) {
      const candidate = paths[(start + i) % paths.length];
      if (display_name(candidate).toLowerCase().startsWith(buffer)) {
        this.moveSelection(candidate);
        return;
      }
    }
  }

  async createFile(parentRel) {
    const parent = canonical_dir(parentRel);
    const { root, rel: parentPath } = split_key(parent);
    const rel = await create_file(parentPath, root);
    if (!rel) return false;
    this.expandedDirs.add(parent);
    await this.ensureLoaded(parent);
    await this.refreshDir(parent);
    this.startRename(node_key(root, rel), { removeIfCanceled: true });
    return true;
  }

  async createFolder(parentRel) {
    const parent = canonical_dir(parentRel);
    const { root, rel: parentPath } = split_key(parent);
    const rel = await create_folder(parentPath, root);
    if (!rel) return false;
    this.expandedDirs.add(parent);
    await this.ensureLoaded(parent);
    await this.refreshDir(parent);
    this.startRename(node_key(root, rel), { removeIfCanceled: true });
    return true;
  }

  async deletePaths(keys) {
    const rels = keys.filter((key) => !is_root_node(key));
    const parents = new Set(rels.map((rel) => parent_dir(rel)));
    const ok = await delete_paths(rels.map(split_key));
    if (!ok) return false;
    for (const rel of rels) this.removeSubtree(rel);
    await Promise.all(Array.from(parents, (parent) => this.refreshDir(parent)));
    this.render();
    return true;
  }

  async duplicate(key) {
    const { root, rel } = split_key(key);
    const destRel = await duplicate_op(rel, root);
    if (!destRel) return false;
    const dest = node_key(root, destRel);
    await this.refreshDir(parent_dir(dest));
    this.setSelection(dest);
    this.render();
    return true;
  }

  startRename(path, options = {}) {
    if (!this.entries.has(path) || is_root_node(path)) return;
    this.activeRenameInput = null;
    this.renameState = { path, removeIfCanceled: Boolean(options.removeIfCanceled), committing: false };
    this.setSelection(path);
    this.render();
  }

  async commitRename(path, rawName, directory) {
    const state = this.renameState;
    if (!state || state.path !== path || state.committing) return;
    const newName = rawName.trim();
    if (!newName || newName === basename(path)) {
      this.renameState = null;
      this.activeRenameInput = null;
      this.render();
      return;
    }
    state.committing = true;
    const dest = path_after_rename(path, newName, directory);
    const { root } = split_key(path);
    const ok = await rename_fs(split_key(path).rel, split_key(dest).rel, directory, root);
    this.renameState = null;
    this.activeRenameInput = null;
    if (ok) {
      this.removeSubtree(path);
      await this.refreshDir(parent_dir(dest));
      this.setSelection(dest);
    }
    this.render();
  }

  async cancelRename() {
    const state = this.renameState;
    if (!state) return;
    this.renameState = null;
    this.activeRenameInput = null;
    if (state.removeIfCanceled) {
      const { root, rel } = split_key(state.path);
      await muxy.files.delete([rel], root_opts(root)).catch(() => undefined);
      await this.refreshDir(parent_dir(state.path));
    }
    this.render();
  }

  async resolveRoot() {
    return (await worktree_root()) ?? null;
  }

  abs_path(key) {
    const { root, rel } = split_key(key);
    const base = root ?? this.worktreeRoot;
    if (!base) return null;
    return `${base.replace(/\/+$/, "")}/${strip_slash(rel)}`;
  }

  file_url(abs) {
    return `file://${abs.split("/").map(encodeURIComponent).join("/")}`;
  }

  async dropPaths(event, targetDirRel) {
    event.preventDefault();
    event.stopPropagation();
    const raw = event.dataTransfer?.getData("application/x-muxy-path");
    this.dropTarget = null;
    if (!raw) return;
    const target = canonical_dir(targetDirRel);
    const targetRoot = split_key(target).root;
    const keys = raw
      .split("\n")
      .map((path) => path.trim())
      .filter(Boolean);
    // muxy.files.move works within one folder only.
    if (keys.some((path) => split_key(path).root !== targetRoot)) {
      void muxy
        .toast({ title: "Move", body: "Items can only be moved within the same folder", variant: "info" })
        .catch(() => undefined);
      this.render();
      return;
    }
    const dragged = keys
      .filter((path) => path !== target && parent_dir(path) !== target && !(path.endsWith("/") && target.startsWith(path)));
    if (dragged.length === 0) {
      this.render();
      return;
    }
    const sourceParents = new Set(dragged.map((path) => parent_dir(path)));
    const ok = await move_fs(dragged.map((path) => split_key(path).rel), split_key(target).rel, targetRoot);
    if (ok) {
      for (const path of dragged) this.removeSubtree(path);
      await Promise.all(Array.from(sourceParents, (parent) => this.refreshDir(parent)));
      await this.ensureLoaded(target);
      await this.refreshDir(target);
    }
    this.render();
  }

  resolveLoadedDir(rawPath) {
    const segs = strip_slash(rawPath).split("/").filter(Boolean);
    const parentEnd = Math.max(0, segs.length - 1);
    let best = "";
    let bestDepth = -1;
    for (const dir of this.loadedDirs) {
      const dirSegs = strip_slash(dir).split("/").filter(Boolean);
      if (dirSegs.length <= bestDepth) continue;
      if (block_ends_within(dirSegs, segs, parentEnd)) {
        best = dir;
        bestDepth = dirSegs.length;
      }
    }
    return best;
  }

  // Extra-folder changes map exactly onto their folder's keys; main-folder
  // changes keep the suffix match against loaded dirs.
  resolveLoadedExtraDir(root, rawPath) {
    const abs = strip_slash(rawPath);
    // A rescan reports the folder itself.
    if (abs === root) return this.loadedDirs.has(node_key(root, "")) ? node_key(root, "") : null;
    if (!abs.startsWith(`${root}/`)) return null;
    let dir = parent_dir(node_key(root, abs.slice(root.length + 1)));
    while (dir !== "" && !this.loadedDirs.has(dir)) dir = parent_dir(dir);
    return dir === "" ? null : dir;
  }

  scheduleReconcile(payload, root = null) {
    const raw = payload && typeof payload === "object" && "path" in payload ? payload.path : undefined;
    if (typeof raw !== "string" || raw.trim() === "") return;
    const dir = root ? this.resolveLoadedExtraDir(root, raw) : this.resolveLoadedDir(raw);
    if (dir === null) return;
    this.pendingDirs.add(dir);
    if (this.reconcileTimer !== null) return;
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null;
      const dirs = Array.from(this.pendingDirs);
      this.pendingDirs.clear();
      void Promise.all(dirs.map((pendingDir) => this.refreshDir(pendingDir))).then(() => this.render());
    }, RECONCILE_DEBOUNCE_MS);
  }

  showContextMenu(item, x, y) {
    this.closeContextMenu();
    const menu = create_context_menu(item, this.ops, () => this.closeContextMenu(), this.selectionList());
    document.body.appendChild(menu);
    const MARGIN = 8;
    const rect = menu.getBoundingClientRect();
    const left = Math.max(MARGIN, Math.min(x, window.innerWidth - rect.width - MARGIN));
    const top = Math.max(MARGIN, Math.min(y, window.innerHeight - rect.height - MARGIN));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    const closeOnPointer = (event) => {
      if (event.target instanceof Node && menu.contains(event.target)) return;
      this.closeContextMenu();
    };
    const closeOnKey = (event) => {
      if (event.key === "Escape") this.closeContextMenu();
    };
    window.addEventListener("mousedown", closeOnPointer, true);
    window.addEventListener("keydown", closeOnKey, true);
    this.contextMenu = menu;
    this.contextDisposers = [
      () => window.removeEventListener("mousedown", closeOnPointer, true),
      () => window.removeEventListener("keydown", closeOnKey, true),
    ];
  }

  closeContextMenu() {
    for (const dispose of this.contextDisposers) dispose();
    this.contextDisposers = [];
    this.contextMenu?.remove();
    this.contextMenu = null;
  }
}
