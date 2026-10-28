// Relative imports keep this module loadable by `node --test`.
import { file_key, strip_slash } from "./files.js";
import { worktree_root } from "./worktree-root.js";

const STORAGE_PREFIX = "muxy.files.draft:";
const MAX_ENTRIES = 50;
const MAX_DRAFT_BYTES = 2_000_000;

function storage_key(root) {
  return `${STORAGE_PREFIX}${root || ""}`;
}

// Main-folder keys stay the bare relative path, so drafts saved before
// multi-root still restore for the main folder.
// `folder` is an extra project folder (null = main folder).
function draft_key(filePath, folder) {
  const rel = strip_slash(String(filePath ?? "")).trim();
  return rel ? file_key(folder, rel) : null;
}

function read_registry(root) {
  try {
    const raw = localStorage.getItem(storage_key(root));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function write_registry(root, registry) {
  try {
    localStorage.setItem(storage_key(root), JSON.stringify(registry));
  } catch {
  }
}

function prune(registry) {
  const keys = Object.keys(registry);
  if (keys.length <= MAX_ENTRIES) return registry;
  keys
    .sort((a, b) => (registry[a].updatedAt ?? 0) - (registry[b].updatedAt ?? 0))
    .slice(0, keys.length - MAX_ENTRIES)
    .forEach((key) => delete registry[key]);
  return registry;
}

export async function read_draft(filePath, folder = null) {
  const rel = draft_key(filePath, folder);
  if (!rel) return null;
  const record = read_registry(await worktree_root())[rel];
  if (!record || typeof record.content !== "string" || typeof record.baseline !== "string") return null;
  return { content: record.content, baseline: record.baseline };
}

export async function write_draft(filePath, content, baseline, folder = null) {
  const rel = draft_key(filePath, folder);
  if (!rel || typeof content !== "string" || typeof baseline !== "string") return;
  if (content.length > MAX_DRAFT_BYTES) return;
  const root = await worktree_root();
  const registry = read_registry(root);
  registry[rel] = { content, baseline, updatedAt: Date.now() };
  write_registry(root, prune(registry));
}

export async function clear_draft(filePath, folder = null) {
  const rel = draft_key(filePath, folder);
  if (!rel) return;
  const root = await worktree_root();
  const registry = read_registry(root);
  if (!(rel in registry)) return;
  delete registry[rel];
  write_registry(root, registry);
}
