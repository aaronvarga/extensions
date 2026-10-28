async function focus_tab(tabId) {
  if (!tabId) return false;
  try {
    await muxy.tabs.switchTo(tabId);
    return true;
  } catch {
    return false;
  }
}

export function strip_slash(path) {
  return path.replace(/\/+$/, "");
}

function path_segments(path) {
  return String(path ?? "")
    .replace(/\/+$/, "")
    .split("/")
    .filter(Boolean);
}

// Extra project folders are addressed by their absolute path; the main folder is
// always `null`, so tabs and drafts saved before multi-root keep their identity.
export function normalize_root(root) {
  return typeof root === "string" && root ? strip_slash(root) || null : null;
}

// Option bag for muxy.files.* calls; empty means the main folder. An object
// rather than undefined/null so a serialized bridge never sees `null` options.
export function root_opts(root) {
  const r = normalize_root(root);
  return r ? { root: r } : {};
}

// exec cwd for an extra folder; empty keeps the host default (main folder).
export function exec_opts(root) {
  const r = normalize_root(root);
  return r ? { cwd: r } : {};
}

export function file_key(root, filePath) {
  const r = normalize_root(root);
  const rel = strip_slash(String(filePath ?? ""));
  return r ? `${r}\0${rel}` : rel;
}

export function editor_tab_data(rel, root) {
  const r = normalize_root(root);
  return r ? { filePath: rel, root: r, replaceable: false } : { filePath: rel, replaceable: false };
}

// `file.changed` payload `root` equals `projectPath` for main-folder changes.
export function change_root(payload) {
  const root = normalize_root(payload?.root);
  return root && root !== normalize_root(payload?.projectPath) ? root : null;
}

export function same_file(payload, filePath, root = null) {
  const changed = payload && typeof payload === "object" ? payload.path : undefined;
  if (typeof changed !== "string") return false;
  const want = normalize_root(root);
  if (change_root(payload) !== want) return false;
  if (want) return strip_slash(changed) === `${want}/${strip_slash(String(filePath ?? ""))}`;
  return same_suffix(changed, filePath);
}

function same_suffix(changedPath, filePath) {
  const want = path_segments(filePath);
  if (want.length === 0) return false;
  const got = path_segments(changedPath);
  if (got.length < want.length) return false;
  const offset = got.length - want.length;
  for (let i = 0; i < want.length; i += 1) {
    if (got[offset + i] !== want[i]) return false;
  }
  return true;
}

export function canonical_dir(rel) {
  const clean = strip_slash(rel);
  return clean ? `${clean}/` : clean;
}

export function parent_dir(rel) {
  const clean = strip_slash(rel);
  const idx = clean.lastIndexOf("/");
  return idx === -1 ? "" : `${clean.slice(0, idx)}/`;
}

export function basename(path) {
  const clean = strip_slash(path);
  const idx = clean.lastIndexOf("/");
  return idx === -1 ? clean : clean.slice(idx + 1);
}

export function extname(path) {
  const name = basename(path).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot);
}

export function resolve_rel(fromRel, target) {
  if (target.startsWith("/")) return null;
  const base = parent_dir(fromRel).split("/").filter(Boolean);
  for (const segment of strip_slash(target).split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (base.length === 0) return null;
      base.pop();
      continue;
    }
    base.push(segment);
  }
  return base.join("/");
}

export function entry_to_rel(entry) {
  const rel = strip_slash(entry.path);
  return entry.isDirectory ? canonical_dir(rel) : rel;
}

export function error_message(err) {
  if (err instanceof Error) return err.message;
  const text = String(err).trim();
  return text || "Unknown error";
}

export async function confirm_action(opts) {
  try {
    const choice = await muxy.dialog.confirm({
      title: opts.title,
      message: opts.message,
      buttons: [opts.confirmLabel, "Cancel"],
      default: "Cancel",
      cancel: "Cancel",
      style: opts.critical ? "critical" : "warning",
    });
    return choice === opts.confirmLabel;
  } catch {
    return false;
  }
}

export async function alert_error(title, err) {
  try {
    await muxy.dialog.alert({ title, message: error_message(err), style: "critical" });
  } catch {
    return;
  }
}

export async function try_action(action, error_title) {
  try {
    await action();
    return true;
  } catch (err) {
    await alert_error(error_title, err);
    return false;
  }
}

async function open_editor_tab(rel, root) {
  try {
    await muxy.tabs.open({
      kind: "extensionWebView",
      extension: {
        id: muxy.extensionID,
        tabType: "code-editor",
        data: editor_tab_data(rel, root),
      },
    });
  } catch (err) {
    await muxy
      .toast({ title: "Open file", body: error_message(err), variant: "error" })
      .catch(() => undefined);
  }
}

export async function open_in_editor(rel, root = null, focusTabId = null) {
  if (focusTabId && (await focus_tab(focusTabId))) return;
  await open_editor_tab(rel, root);
}

export async function open_in_new_tab(rel, root = null) {
  await open_editor_tab(rel, root);
}

export async function is_internal_file(rel, root = null) {
  const path = strip_slash(rel);
  if (!path) return false;
  try {
    const stat = await muxy.files.stat(path, root_opts(root));
    return Boolean(stat) && !stat.isDirectory;
  } catch {
    return false;
  }
}

export async function reveal_in_finder(rel, root = null) {
  await muxy.exec(["open", "-R", strip_slash(rel)], exec_opts(root)).catch(() => undefined);
}

export async function reveal_paths(rels, root = null) {
  const paths = rels.map((rel) => strip_slash(rel));
  if (paths.length === 0) return;
  await muxy.exec(["open", "-R", ...paths], exec_opts(root)).catch(() => undefined);
}

export async function open_externally(rel, root = null) {
  await muxy.exec(["open", strip_slash(rel)], exec_opts(root)).catch(() => undefined);
}

export async function open_url(url) {
  await muxy.exec(["open", url]).catch(() => undefined);
}

export async function copy_path(rel) {
  const path = strip_slash(rel);
  try {
    await navigator.clipboard.writeText(path);
    await muxy.toast({ body: "Path copied", variant: "info" }).catch(() => undefined);
  } catch {
    await muxy.toast({ title: "Copy path", body: path, variant: "info" }).catch(() => undefined);
  }
}

export async function copy_paths(rels) {
  const paths = rels.map((rel) => strip_slash(rel));
  const text = paths.join("\n");
  const body = paths.length === 1 ? "Path copied" : `${paths.length} paths copied`;
  try {
    await navigator.clipboard.writeText(text);
    await muxy.toast({ body, variant: "info" }).catch(() => undefined);
  } catch {
    await muxy.toast({ title: "Copy paths", body: text, variant: "info" }).catch(() => undefined);
  }
}
