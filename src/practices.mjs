// Counts the seven code practices of `rebase-practices/v1` per session, in the
// order the events happened (message order, then tool-use order). Every number
// is "sessions where the practice was seen" over "sessions where it could have
// been": a session whose log lacks a field a practice needs (see `needs` in
// practices-rules.mjs), or whose adapter cannot show it (ADAPTERS_WITHOUT), is
// left out of that denominator, never counted as "not seen".
import { DEFAULT_TZ, isValidTimezone, monthKeyFor } from "./days.mjs";
import { isEphemeral, repoKey, splitTopLevel, stripHeredocs } from "./digest.mjs";
import {
  ADAPTERS_WITHOUT, CODE_PRACTICES, isCheckCommand, isCommitCommand, isDesignDocPath, isDiffCommand,
  isPlanPath, isSecurityCommand, isSourcePath, isTestPath, stripToExecutable,
} from "./practices-rules.mjs";

// The canonical edit names every adapter maps onto (codex apply_patch and
// opencode patch arrive as "Edit", cursor StrReplace as "Edit").
const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
const PLAN_TOOLS = new Set(["ExitPlanMode", "TodoWrite"]);

const PR_CREATE = /^gh\s+pr\s+create(?=\s|$)/;
const CODE_FILE = /\.(?:js|mjs|cjs|jsx|ts|mts|cts|tsx|py|go|rs|rb|java|kt|php|cs|c|cpp|h|swift|sh)$/i;

const subCommands = (cmd) => splitTopLevel(stripHeredocs(String(cmd ?? ""))).map((p) => p.trim()).filter(Boolean);

// A comparable key for "the same check": the first check sub-command, reduced
// to its executable words (env assignments and the npx, uv run, python -m,
// pnpm exec wrappers dropped, runner lower-cased) up to the first flag or
// path-like argument. A narrower run of a check keys like the broader one:
//   "pytest tests/a.py -q", "pytest -x tests/", "uv run pytest" -> "pytest"
//   "FOO=1  npx   vitest run test/a.test.ts"                    -> "vitest run"
//   "go test -run X ./pkg/..."                                  -> "go test"
// A command that holds no check has no key ("").
export function normalizeCommand(cmd) {
  const part = subCommands(cmd).find((p) => isCheckCommand(p));
  if (!part) return "";
  const tokens = stripToExecutable(part).split(/\s+/).filter(Boolean);
  const at = tokens.findIndex((t, i) => i > 0 && (t.startsWith("-") || t === "." || t === ".." || /[\\/]/.test(t) || CODE_FILE.test(t)));
  const kept = at < 0 ? tokens : tokens.slice(0, at);
  if (kept.length) kept[0] = kept[0].toLowerCase();
  return kept.join(" ");
}

// The ordered "atoms" of a session: one per edit, planning tool, or sub-command
// of a shell command (so `npm test && git commit` keeps its internal order).
function readSession(session) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  const results = new Map();
  const uses = [];
  let hasToolUses = false;
  let hasResults = false;
  for (const m of messages) {
    if (Array.isArray(m?.toolUses)) { hasToolUses = true; uses.push(...m.toolUses.filter(Boolean)); }
    if (Array.isArray(m?.toolResults)) {
      hasResults = true;
      for (const r of m.toolResults) if (r && r.forId != null) results.set(r.forId, r.isError);
    }
  }
  const atoms = [];
  const bash = []; // one per Bash tool use: { e, id, cmd }
  let cmdOk = hasToolUses;
  let pathOk = hasToolUses;
  uses.forEach((u, e) => {
    if (EDIT_TOOLS.has(u.name)) {
      // An empty path (codex apply_patch it could not parse) names no file.
      if (typeof u.path !== "string" || u.path === "") pathOk = false;
      atoms.push({ e, edit: true, path: typeof u.path === "string" ? u.path : "" });
    } else if (PLAN_TOOLS.has(u.name)) {
      atoms.push({ e, plan: true });
    } else if (u.name === "Bash") {
      if (typeof u.cmd !== "string") { cmdOk = false; return; }
      bash.push({ e, id: u.id, cmd: u.cmd });
      for (const part of subCommands(u.cmd)) {
        atoms.push({
          e,
          check: isCheckCommand(part),
          security: isSecurityCommand(part),
          diff: isDiffCommand(part),
          commit: isCommitCommand(part),
          pr: PR_CREATE.test(stripToExecutable(part)),
        });
      }
    }
  });
  return { atoms, bash, results, ok: { "toolUses.cmd": cmdOk, "toolUses.path": pathOk, "toolResults.isError": hasResults } };
}

// A check after the last edit before some commit (anywhere before it when no
// edit precedes it).
function checkedBeforeCommit(atoms) {
  let lastEdit = -1;
  let lastCheck = -1;
  for (const [i, a] of atoms.entries()) {
    if (a.check) lastCheck = i;
    if (a.commit && lastCheck > lastEdit) return true;
    if (a.edit) lastEdit = i;
  }
  return false;
}

function reviewedBeforeDelivery(atoms) {
  let diffSeen = false;
  for (const a of atoms) {
    if (a.diff) diffSeen = true;
    if ((a.commit || a.pr) && diffSeen) return true;
  }
  return false;
}

// A command failed, files were edited, and the same command then succeeded.
function failureReproduced(bash, atoms, results) {
  const editEvents = atoms.filter((a) => a.edit).map((a) => a.e);
  for (const f of bash) {
    if (results.get(f.id) !== true) continue;
    const key = normalizeCommand(f.cmd);
    if (!key) continue;
    const fix = editEvents.find((e) => e > f.e);
    if (fix === undefined) continue;
    if (bash.some((c) => c.e > fix && results.get(c.id) === false && normalizeCommand(c.cmd) === key)) return true;
  }
  return false;
}

// One session's facts. `seen` and `denom` are keyed by practice id.
export function sessionFacts(session) {
  const { atoms, bash, results, ok } = readSession(session);
  const edits = atoms.filter((a) => a.edit);
  const commits = atoms.filter((a) => a.commit).length;
  const prs = atoms.filter((a) => a.pr).length;
  const failed = bash.filter((c) => results.get(c.id) === true);
  const sourceEdits = edits.filter((a) => isSourcePath(a.path)).length;
  const testEdits = edits.filter((a) => isTestPath(a.path)).length;
  const firstEdit = atoms.findIndex((a) => a.edit);

  const seen = {
    checks_before_commit: checkedBeforeCommit(atoms),
    tests_with_changes: sourceEdits > 0 && testEdits > 0,
    failure_reproduced_before_fix: failureReproduced(bash, atoms, results),
    plan_before_edit: firstEdit >= 0 && (atoms.slice(0, firstEdit).some((a) => a.plan) || isPlanPath(atoms[firstEdit].path)),
    reviews_changes: reviewedBeforeDelivery(atoms),
    design_documents: edits.some((a) => isDesignDocPath(a.path)),
    security_checks: atoms.some((a) => a.security),
  };
  const has = {
    checks_before_commit: commits > 0,
    tests_with_changes: sourceEdits > 0,
    failure_reproduced_before_fix: failed.some((c) => normalizeCommand(c.cmd)) && !ADAPTERS_WITHOUT.failure_reproduced_before_fix.includes(session?.source),
    plan_before_edit: edits.length > 0,
    reviews_changes: commits + prs > 0,
    design_documents: edits.length > 0,
    security_checks: edits.length > 0,
  };
  const denom = {};
  for (const p of CODE_PRACTICES) denom[p.id] = has[p.id] && p.needs.every((f) => ok[f]);
  return { edits: edits.length, sourceEdits, testEdits, commits, prs, failedCommands: failed.length, seen, denom };
}

// The sessions the digest reads (ephemeral sandboxes are skipped), each with the
// product and month the counts are grouped by.
function* eachSession(parsed, tz) {
  const monthKey = monthKeyFor(tz);
  const sessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
  for (const [i, s] of sessions.entries()) {
    const cwd = s?.cwdRaw || s?.cwdRedacted || "";
    if (isEphemeral(cwd)) continue;
    let month = null;
    for (const m of Array.isArray(s.messages) ? s.messages : []) {
      const t = m?.ts ? Date.parse(m.ts) : NaN;
      if (Number.isFinite(t)) { month = monthKey(t); break; }
    }
    yield {
      session: s,
      meta: { id: String(s.sessionId ?? `#${i}`), product: repoKey(s.cwdRedacted || cwd), month, source: s.source || "unknown" },
    };
  }
}

export function practiceSessions(parsed, { tz = DEFAULT_TZ } = {}) {
  return [...eachSession(parsed, tz)].map(({ meta }) => meta);
}

export function computeCodePractices(parsed, { tz = DEFAULT_TZ } = {}) {
  const acc = new Map(CODE_PRACTICES.map((p) => [p.id, { seen: 0, of: 0, products: new Set(), months: new Set() }]));
  for (const { session, meta } of eachSession(parsed, tz)) {
    const facts = sessionFacts(session);
    for (const [id, a] of acc) {
      if (!facts.denom[id]) continue;
      a.of++;
      if (!facts.seen[id]) continue;
      a.seen++;
      a.products.add(meta.product);
      if (meta.month) a.months.add(meta.month);
    }
  }
  const items = CODE_PRACTICES.filter((p) => acc.get(p.id).of > 0).map((p) => {
    const a = acc.get(p.id);
    return { id: p.id, method: p.method, seen: a.seen, of: a.of, products: a.products.size, months: a.months.size };
  });
  return items.length ? { items } : null;
}

// The zone the submit-time re-derivation must bucket months in: the one the
// profile recorded, never the machine's (as recordedTechUsageTz).
export function recordedPracticesTz(profile) {
  const tz = profile?.practices?.timezone;
  return isValidTimezone(tz) ? tz : DEFAULT_TZ;
}
