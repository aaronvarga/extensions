let cachedRoot;
let resolved = false;

export async function worktree_root() {
  if (resolved) return cachedRoot;
  // muxy.exec runs in the active worktree by default, so `pwd` names it
  // without the worktrees:read permission this extension doesn't have.
  try {
    const res = await muxy.exec(["pwd"]);
    cachedRoot = res?.exitCode === 0 ? res.stdout.trim() || undefined : undefined;
  } catch {
    cachedRoot = undefined;
  }
  resolved = true;
  return cachedRoot;
}

function invalidate() {
  resolved = false;
  cachedRoot = undefined;
}

muxy.events.subscribe("project.switched", invalidate);
muxy.events.subscribe("worktree.switched", invalidate);
