import { MAX_RESULTS, SEARCH_EXIT_MARKER } from "./constants.js";
import { git_grep_request, grep_request, rg_request } from "./commands.js";
import {
  is_search_too_short,
  parse_result_id,
  parse_result_line,
  query_variants,
  search_options,
} from "./query.js";

const COMMAND_NOT_FOUND_EXIT_CODE = 127;
// git grep exits 128 outside a Git work tree and 129 when it is too old for an option.
const GIT_GREP_UNAVAILABLE_EXIT_CODES = [COMMAND_NOT_FOUND_EXIT_CODE, 128, 129];
const SEARCH_CACHE_LIMIT = 20;
// Extra project folders are searched at most this many at a time.
const ROOT_CONCURRENCY = 2;

let searchCache = new Map();
let searchSerial = 0;
let searchTimer = null;
let searchTimerResolve = null;
let currentExecHandles = new Set();

export function open_find_in_files() {
  muxy.modal.open({
    placeholder: "Find in files...",
    emptyLabel: "Type 2 or more characters",
    noMatchLabel: "No matches",
    searchToolbar: true,
    items: [],
    onQuery: handle_query,
    onSelect: open_result,
  });
}

function handle_query(query, emitOrOptions, maybeOptions) {
  const emit = typeof emitOrOptions === "function" ? emitOrOptions : null;
  const rawOptions = typeof emitOrOptions === "function" ? maybeOptions : emitOrOptions;
  const options = search_options(rawOptions);
  const variants = query_variants(query, options);
  if (variants.length === 0 || is_search_too_short(variants[0], options)) {
    cancel_scheduled_search();
    return [];
  }

  const roots = search_roots();
  const cacheKey = search_key(variants, options, roots);
  const cachedItems = cached_items(cacheKey);
  if (cachedItems) {
    if (emit) return schedule_cached_emit(cachedItems, emit);
    cancel_scheduled_search();
    return [];
  }

  if (emit) return schedule_search({ cacheKey, variants, options, roots, emit });
  cancel_scheduled_search();
  return [];
}

// `null` is the main folder; extra folders come from the active project.
// runScript calls are synchronous, and a host without folders yields [null].
function search_roots() {
  try {
    const projects = muxy.projects?.list?.();
    const active = Array.isArray(projects) ? projects.find((p) => p && p.isActive) : null;
    const folders = active && Array.isArray(active.folders) ? active.folders : [];
    const extra = folders
      .filter((f) => typeof f === "string" && f)
      .map((f) => f.replace(/\/+$/, ""))
      .filter(Boolean);
    return [null, ...new Set(extra)];
  } catch {
    return [null];
  }
}

function cancel_running_search() {
  const handles = Array.from(currentExecHandles);
  currentExecHandles.clear();
  for (const handle of handles) {
    try {
      handle.cancel();
    } catch (_) {
      // ignore — best-effort cancel of a background exec
    }
  }
}

function cancel_scheduled_search() {
  cancel_running_search();
  searchSerial += 1;
  if (searchTimer != null) {
    searchTimer.cancel();
    searchTimer = null;
  }
  resolve_scheduled_search();
}

function schedule_search(search) {
  cancel_scheduled_search();
  const serial = searchSerial;
  return new Promise((resolve) => {
    searchTimerResolve = resolve;
    const task = schedule_deferred_task(() => {
      if (searchTimer === task) searchTimer = null;
      const done = () => resolve_scheduled_search(resolve);
      if (serial !== searchSerial) {
        done();
        return;
      }
      perform_search(search.variants, search.options, search.roots, serial)
        .then((result) => {
          if (serial !== searchSerial) return;
          if (result.cacheable) {
            cache_items(search.cacheKey, result.items);
          }
          search.emit(result.items);
        })
        .catch(() => {
          // search superseded or failed — emit handled by the latest query
        })
        .finally(done);
    });
    searchTimer = task;
  });
}

function schedule_cached_emit(items, emit) {
  cancel_scheduled_search();
  const serial = searchSerial;
  return new Promise((resolve) => {
    searchTimerResolve = resolve;
    const task = schedule_deferred_task(() => {
      if (searchTimer === task) searchTimer = null;
      if (serial === searchSerial) {
        emit(clone_items(items));
      }
      resolve_scheduled_search(resolve);
    });
    searchTimer = task;
  });
}

function schedule_deferred_task(callback) {
  let canceled = false;
  const run = () => {
    if (!canceled) callback();
  };

  if (typeof setTimeout === "function") {
    const timeout = setTimeout(run, 0);
    return {
      cancel() {
        canceled = true;
        if (typeof clearTimeout === "function") clearTimeout(timeout);
      },
    };
  }

  if (typeof setImmediate === "function") {
    const immediate = setImmediate(run);
    return {
      cancel() {
        canceled = true;
        if (typeof clearImmediate === "function") clearImmediate(immediate);
      },
    };
  }

  if (typeof queueMicrotask === "function") {
    queueMicrotask(run);
    return {
      cancel() {
        canceled = true;
      },
    };
  }

  Promise.resolve().then(run);
  return {
    cancel() {
      canceled = true;
    },
  };
}

function resolve_scheduled_search(expectedResolve) {
  const resolve = searchTimerResolve;
  if (!resolve) return;
  if (expectedResolve && resolve !== expectedResolve) return;
  searchTimerResolve = null;
  resolve();
}

async function perform_search(variants, options, roots, serial) {
  let collected = 0;
  const outcomes = await map_limit(roots, ROOT_CONCURRENCY, async (root) => {
    // Don't launch a folder once superseded or once earlier folders filled the list.
    if (serial !== searchSerial || collected >= MAX_RESULTS) return null;
    const response = await search_root(variants, options, root, serial);
    const items = response.ok ? result_items(response.result, root) : [];
    collected += items.length;
    return { response, items };
  });
  const done = outcomes.filter(Boolean);

  // Folders that failed are dropped; the rest still show, uncached.
  const items = done.flatMap((outcome) => outcome.items).slice(0, MAX_RESULTS);
  if (items.length > 0) {
    const cacheable = done.every((outcome) => outcome.response.ok && is_cacheable_result(outcome.response.result));
    return { items, cacheable };
  }
  const failures = done.filter(
    (outcome) => !(outcome.response.ok && is_empty_success_result(outcome.response.result)),
  );
  if (failures.length === 0) return { items: [], cacheable: done.length > 0 };
  if (failures.length < done.length) return { items: [], cacheable: false };
  return failure_result(failures[0].response, variants, options);
}

async function map_limit(values, limit, fn) {
  const out = new Array(values.length);
  let next = 0;
  const worker = async () => {
    while (next < values.length) {
      const index = next++;
      out[index] = await fn(values[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return out;
}

async function search_root(variants, options, root, serial) {
  let response = await run_request(rg_request(variants, options), root, serial);
  if (is_unavailable(response, [COMMAND_NOT_FOUND_EXIT_CODE])) {
    response = await run_request(git_grep_request(variants, options), root, serial);
    if (is_unavailable(response, GIT_GREP_UNAVAILABLE_EXIT_CODES)) {
      response = await run_request(grep_request(variants, options), root, serial);
    }
  }
  return response;
}

function failure_result(response, variants, options) {
  const result = response.ok ? response.result : null;
  if (is_cancelled_response(response)) {
    return { items: [], cacheable: false };
  }
  if (is_timed_out_response(response)) {
    return search_error("Search timed out", variants[0]);
  }
  if (options.regex && response.ok && search_exit_code(result) > 1) {
    return search_error("Invalid pattern", variants[0]);
  }
  return search_error("Search failed", variants[0]);
}

async function run_request(request, root, serial) {
  // A superseded search must not launch its next fallback command.
  if (serial !== searchSerial) return { ok: false, error: { cancelled: true } };
  const execOptions = { stdin: request.stdin, timeoutMs: request.timeoutMs };
  if (root) execOptions.cwd = root;
  const handle = muxy.execAsync(request.argv, execOptions);
  if (
    !handle ||
    typeof handle.cancel !== "function" ||
    typeof handle.result?.then !== "function"
  ) {
    return { ok: false, error: new Error("muxy.execAsync unavailable") };
  }

  currentExecHandles.add(handle);

  try {
    const result = await handle.result;
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error };
  } finally {
    currentExecHandles.delete(handle);
  }
}

function is_unavailable(response, exitCodes) {
  if (response.ok) {
    return !response.result?.timedOut && exitCodes.includes(search_exit_code(response.result));
  }
  return is_command_not_found_error(response.error);
}

function result_items(result, root) {
  if (!result) return [];
  const seen = new Set();
  const items = [];
  const stdout = String(result.stdout || "");
  let start = 0;
  while (start < stdout.length && items.length < MAX_RESULTS) {
    const newline = stdout.indexOf("\n", start);
    const line = newline === -1 ? stdout.slice(start) : stdout.slice(start, newline);
    const item = parse_result_line(line, root);
    if (item && !seen.has(item.id)) {
      seen.add(item.id);
      items.push(item);
    }
    if (newline === -1) break;
    start = newline + 1;
  }
  return items;
}

function is_cacheable_result(result) {
  if (!result || result.timedOut) return false;
  const exitCode = search_exit_code(result);
  return (
    exitCode === 0 ||
    exitCode === 1 ||
    (exitCode === 141 && Boolean(result.stdout))
  );
}

function is_empty_success_result(result) {
  if (!result || result.timedOut) return false;
  const exitCode = search_exit_code(result);
  return exitCode === 0 || exitCode === 1;
}

function search_exit_code(result) {
  if (!result) return -1;
  const stderr = String(result.stderr || "");
  const marker = stderr.lastIndexOf(SEARCH_EXIT_MARKER);
  if (marker >= 0) {
    const value = parseInt(stderr.slice(marker + SEARCH_EXIT_MARKER.length), 10);
    if (Number.isFinite(value)) return value;
  }
  return Number.isFinite(result.exitCode) ? result.exitCode : -1;
}

function is_command_not_found_error(error) {
  if (!error || is_cancelled_error(error) || is_timeout_error(error)) return false;
  const message = String(error.message || error).toLowerCase();
  return message.includes("command not found:") || message.includes("enoent");
}

function is_cancelled_response(response) {
  return !response.ok && is_cancelled_error(response.error);
}

function is_cancelled_error(error) {
  return Boolean(error && (error.cancelled || error.code === "cancelled"));
}

function is_timed_out_response(response) {
  if (response.ok) return Boolean(response.result && response.result.timedOut);
  return is_timeout_error(response.error);
}

function is_timeout_error(error) {
  if (!error || is_cancelled_error(error)) return false;
  const message = String(error.message || error).toLowerCase();
  return message.includes("timed out") || message.includes("timeout");
}

function search_error(title, subtitle) {
  return {
    items: [{ id: "__error__", title, subtitle: String(subtitle || "") }],
    cacheable: false,
  };
}

export function reset_find_in_files_state_for_tests() {
  searchCache = new Map();
  cancel_scheduled_search();
}

function search_key(variants, options, roots) {
  return JSON.stringify({
    caseSensitive: options.caseSensitive,
    wholeWord: options.wholeWord,
    regex: options.regex,
    variants,
    roots,
  });
}

function clone_items(items) {
  return items.map((item) => ({ ...item }));
}

function cached_items(cacheKey) {
  if (!searchCache.has(cacheKey)) return null;
  const items = searchCache.get(cacheKey);
  searchCache.delete(cacheKey);
  searchCache.set(cacheKey, items);
  return clone_items(items);
}

function cache_items(cacheKey, items) {
  searchCache.set(cacheKey, clone_items(items));
  if (searchCache.size <= SEARCH_CACHE_LIMIT) return;

  const oldestKey = searchCache.keys().next().value;
  searchCache.delete(oldestKey);
}

function open_result(choice) {
  if (!choice) return;
  const result = parse_result_id(choice.id);
  if (!result) return;

  const extId = (typeof muxy !== "undefined" && muxy.extensionID) || "files";
  muxy.tabs.open({
    kind: "extensionWebView",
    extension: {
      id: extId,
      tabType: "code-editor",
      singleton: false,
      data: result.root
        ? { filePath: result.filePath, root: result.root, line: result.lineNumber, replaceable: false }
        : { filePath: result.filePath, line: result.lineNumber, replaceable: false },
    },
  });
}
