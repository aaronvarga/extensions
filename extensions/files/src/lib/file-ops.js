import {
  alert_error,
  basename,
  canonical_dir,
  confirm_action,
  exec_opts,
  parent_dir,
  root_opts,
  try_action,
} from "@/lib/files";

const NEW_FILE_NAME = "untitled";
const NEW_FOLDER_NAME = "untitled-folder";

function split_ext(name, isFolder) {
  if (isFolder) return { stem: name, ext: "" };
  const idx = name.lastIndexOf(".");
  if (idx <= 0) return { stem: name, ext: "" };
  return { stem: name.slice(0, idx), ext: name.slice(idx) };
}

export async function create_file(parentRel, root = null) {
  const parent = canonical_dir(parentRel);
  const rel = `${parent}${NEW_FILE_NAME}`;
  const ok = await try_action(async () => {
    await muxy.files.write(rel, "", root_opts(root));
  }, "Create File");
  return ok ? rel : null;
}

export async function create_folder(parentRel, root = null) {
  const parent = canonical_dir(parentRel);
  const rel = canonical_dir(`${parent}${NEW_FOLDER_NAME}`);
  const ok = await try_action(async () => {
    await muxy.files.mkdir(rel, root_opts(root));
  }, "Create Folder");
  return ok ? rel : null;
}

// `items` are { rel, root } and may span folders: one confirmation, then one
// delete per folder since a muxy.files call addresses a single root.
export async function delete_paths(items) {
  if (items.length === 0) return false;
  const count = items.length;
  const label = count === 1 ? basename(items[0].rel) : `${count} items`;
  const confirmed = await confirm_action({
    critical: true,
    title: "Delete",
    message: `Move ${label} to Trash?`,
    confirmLabel: "Delete",
  });
  if (!confirmed) return false;
  return try_action(async () => {
    const byRoot = new Map();
    for (const { rel, root } of items) {
      if (!byRoot.has(root)) byRoot.set(root, []);
      byRoot.get(root).push(rel);
    }
    // Each folder is its own call, so one failing must not hide what the
    // others already moved to Trash.
    let moved = 0;
    const failures = [];
    for (const [root, rels] of byRoot) {
      try {
        await muxy.files.delete(rels, root_opts(root));
        moved += rels.length;
      } catch (err) {
        failures.push(`${root ? basename(root) : "project folder"}: ${err?.message || err}`);
      }
    }
    if (failures.length > 0) {
      const done = moved > 0 ? `${moved} of ${count} items were moved to Trash. ` : "";
      throw new Error(`${done}Failed in ${failures.join("; ")}`);
    }
  }, "Delete");
}

export async function duplicate(rel, root = null) {
  const isFolder = rel.endsWith("/");
  const parent = parent_dir(rel);
  const name = basename(rel);
  const { stem, ext } = split_ext(name, isFolder);

  let destName = `${stem} copy${ext}`;
  for (let n = 2; ; n++) {
    const candidate = `${parent}${destName}`;
    let exists = true;
    try {
      await muxy.files.stat(candidate, root_opts(root));
    } catch {
      exists = false;
    }
    if (!exists) break;
    destName = `${stem} copy ${n}${ext}`;
  }

  const destRelRaw = `${parent}${destName}`;
  const ok = await try_action(async () => {
    const result = await muxy.exec(["cp", "-R", strip_slash_local(rel), strip_slash_local(destRelRaw)], exec_opts(root));
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `cp exited ${result.exitCode}`);
  }, "Duplicate");
  if (!ok) return null;
  return isFolder ? canonical_dir(destRelRaw) : destRelRaw;
}

function strip_slash_local(path) {
  return path.replace(/\/+$/, "");
}

export async function rename_fs(sourceRel, destRel, isFolder, root = null) {
  const sourcePath = isFolder ? canonical_dir(sourceRel) : sourceRel;
  const newName = basename(destRel);
  try {
    await muxy.files.rename(sourcePath, newName, root_opts(root));
    return true;
  } catch (err) {
    await alert_error("Rename", err);
    return false;
  }
}

export async function move_fs(draggedRels, targetDirRel, root = null) {
  if (draggedRels.length === 0) return true;
  const into = strip_slash_local(targetDirRel);
  try {
    await muxy.files.move(draggedRels.map((rel) => strip_slash_local(rel)), into, root_opts(root));
    return true;
  } catch (err) {
    await alert_error("Move", err);
    return false;
  }
}
