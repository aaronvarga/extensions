const SKIP_DIRS = [".git", "node_modules", ".svn", ".hg"];
const MAX_FILES = 50000;
const ENUM_TIMEOUT_SECS = 1;
const INITIAL_LIMIT = 1000;
const FIRST_PAINT = 50;
const MAX_RESULTS = 200;

function basename(path) {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

function strip_slash(path) {
  return path.replace(/\/+$/, "");
}

// Main-folder ids stay the bare relative path; extra-folder ids are
// `<root>\0<rel>` (paths cannot contain NUL).
function to_item(rel, group) {
  if (!group.root) return { id: rel, title: basename(rel), subtitle: rel };
  return { id: `${group.root}\0${rel}`, title: basename(rel), subtitle: `${group.name} • ${rel}` };
}

function group_items(group, from, to) {
  return group.files.slice(from, to).map((rel) => to_item(rel, group));
}

// runScript calls are synchronous; a host without projects/folders support
// just yields the main folder.
function extra_folders() {
  try {
    const projects = muxy.projects.list();
    const active = Array.isArray(projects) ? projects.find((p) => p && p.isActive) : null;
    const folders = active && Array.isArray(active.folders) ? active.folders : [];
    const roots = folders.filter((f) => typeof f === "string" && f).map(strip_slash).filter(Boolean);
    return Array.from(new Set(roots));
  } catch {
    return [];
  }
}

const TIMEOUT_PERL =
  '$SIG{ALRM}=sub{kill "KILL",-$p if $p;exit};' +
  "$p=fork();if(!$p){setpgrp(0,0);exec @ARGV or exit}" +
  `alarm ${ENUM_TIMEOUT_SECS};waitpid($p,0);`;

function timed_lines(argv, sep, root, limit) {
  let out = "";
  try {
    const result = muxy.exec(["perl", "-e", TIMEOUT_PERL, "--", ...argv], root ? { cwd: root } : {});
    out = (result && result.stdout) || "";
  } catch {
    return null;
  }
  if (!out) return null;
  const files = [];
  for (const rel of out.split(sep)) {
    if (rel) files.push(strip_slash(rel.replace(/^\.\//, "")));
    if (files.length >= limit) break;
  }
  return files.length ? files : null;
}

function git_files(root, limit) {
  return timed_lines(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    "\0",
    root,
    limit,
  );
}

function find_files(root, limit) {
  const argv = ["find", ".", "-type", "f"];
  for (const dir of SKIP_DIRS) {
    argv.push("-not", "-path", `*/${dir}/*`);
  }
  return timed_lines(argv, "\n", root, limit) || [];
}

// One group per folder, main first. MAX_FILES caps the total across folders.
let file_groups = null;
function enumerate(on_group) {
  const groups = [];
  let total = 0;
  for (const root of [null, ...extra_folders()]) {
    const limit = MAX_FILES - total;
    if (limit <= 0) break;
    const files = git_files(root, limit) || find_files(root, limit);
    const group = { root, name: root ? basename(root) : "", files };
    groups.push(group);
    total += files.length;
    if (on_group) on_group(group);
  }
  return groups;
}

function get_groups() {
  if (file_groups === null) file_groups = enumerate();
  return file_groups;
}

// The first INITIAL_LIMIT files across folders, in folder order.
function initial_items(groups) {
  const items = [];
  for (const group of groups) {
    const room = INITIAL_LIMIT - items.length;
    if (room <= 0) break;
    items.push(...group_items(group, 0, room));
  }
  return items;
}

function match_score(path, query) {
  const haystack = path.toLowerCase();
  const idx = haystack.indexOf(query);
  if (idx === -1) return -1;
  const nameStart = haystack.lastIndexOf("/") + 1;
  const inName = idx >= nameStart;
  return (inName ? 0 : 1000) + Math.min(idx - (inName ? nameStart : 0), 999);
}

function search(query) {
  const needle = query.toLowerCase();
  const matches = [];
  for (const group of get_groups()) {
    for (const rel of group.files) {
      const score = match_score(rel, needle);
      if (score >= 0) matches.push({ rel, group, score });
    }
  }
  matches.sort((a, b) => a.score - b.score || a.rel.length - b.rel.length);
  return matches.slice(0, MAX_RESULTS).map((m) => to_item(m.rel, m.group));
}

muxy.modal.open({
  placeholder: "Go to file…",
  emptyLabel: "No files",
  noMatchLabel: "No matching files",
  items(emit) {
    // Emit each folder as soon as it is enumerated instead of waiting for all.
    let emitted = 0;
    const groups = enumerate((group) => {
      const room = INITIAL_LIMIT - emitted;
      if (room <= 0) return;
      const first = Math.min(room, FIRST_PAINT);
      emit(group_items(group, 0, first));
      if (group.files.length > first) emit(group_items(group, first, room));
      emitted += Math.min(room, group.files.length);
    });
    if (file_groups === null) file_groups = groups;
  },
  onQuery(query) {
    if (!query) return initial_items(get_groups());
    return search(query);
  },
  onSelect(choice) {
    if (!choice) return;
    const sep = choice.id.indexOf("\0");
    const data =
      sep === -1
        ? { filePath: choice.id, replaceable: false }
        : { filePath: choice.id.slice(sep + 1), root: choice.id.slice(0, sep), replaceable: false };
    const extId = (typeof muxy !== "undefined" && muxy.extensionID) || "files";
    try {
      muxy.tabs.open({
        kind: "extensionWebView",
        extension: {
          id: extId,
          tabType: "code-editor",
          singleton: false,
          data,
        },
      });
    } catch (err) {
      console.error(
        "[quick-open] tabs.open FAILED" +
          " extId=" + String(extId) +
          " muxy.extensionID=" + String(typeof muxy !== "undefined" ? muxy.extensionID : "n/a") +
          " tabType=code-editor file=" + choice.id +
          " error=" + String((err && err.message) || err),
      );
    }
  },
});
