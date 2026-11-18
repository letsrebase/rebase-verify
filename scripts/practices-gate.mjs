// The quality gate of the six model practices. A practice ships only when its
// stability (two runs on the same 40 real sessions) and its agreement with a
// written reference set are both >= 90%. A developer tool, not product code.
//
//   node scripts/practices-gate.mjs stability [--root <dir>] [--exclude-path <substring>]...
//                                   [--via api|claude] [--out <file outside the repo>]
//   node scripts/practices-gate.mjs agreement [--dir <fixtures dir>] [--via api|claude] [--out <file>]
//   node scripts/practices-gate.mjs report --stability <file> --agreement <file>
//
// The real sessions are read in memory and never written; the stability output
// holds booleans keyed by opaque ids and numbers, no message, path or product.
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { DEFAULT_TZ } from "../src/days.mjs";
import { eachSession } from "../src/practices.mjs";
import { classifyPractices } from "../src/practices-llm.mjs";
import { personMessages } from "../src/practices-sample.mjs";
import { MODEL_PRACTICE_CANDIDATES, RUBRIC } from "../src/practices-rules.mjs";
import { MODEL, anthropicCall } from "../src/profile-llm.mjs";
import { readAllSources } from "../src/sources.mjs";

export const STABILITY_MIN = 0.9;
export const AGREEMENT_MIN = 0.9;
export const STABILITY_SESSIONS = 40;
// The agreement run shuffles with this fixed seed so it is reproducible.
export const SHUFFLE_SEED = 20261118;
export const DEFAULT_DIR = "test/fixtures/practices-reference";

const IDS = MODEL_PRACTICE_CANDIDATES.map((p) => p.id);
const execFileAsync = promisify(execFile);

// ---- pure scoring ----------------------------------------------------------

const ratio = (n, of) => ({ rate: of ? n / of : 0 });

// answers, expected: { <session id>: { <practice>: boolean } }. Sessions are the
// expected ones; a session with no answer counts as a mismatch.
export function agreement(answers, expected, id) {
  const keys = Object.keys(expected);
  const matched = keys.filter((k) => answers?.[k]?.[id] === expected[k]?.[id]).length;
  return { matched, of: keys.length, ...ratio(matched, keys.length) };
}

// runA, runB: { <session id>: { <practice>: boolean } }. Sessions are runA's.
export function stability(runA, runB, id) {
  const keys = Object.keys(runA);
  const same = keys.filter((k) => runB?.[k]?.[id] === runA[k]?.[id]).length;
  return { same, of: keys.length, ...ratio(same, keys.length) };
}

const measured = (m) => (m && m.of > 0 && Number.isFinite(m.rate) ? m.rate : null);

// stability, agreement: { <practice>: { rate, of, ... } }. One entry per candidate.
export function gateReport({ stability: st = {}, agreement: ag = {} } = {}) {
  return IDS.map((id) => {
    const s = measured(st[id]);
    const a = measured(ag[id]);
    const pass = s !== null && a !== null && s >= STABILITY_MIN - 1e-9 && a >= AGREEMENT_MIN - 1e-9;
    return { id, stability: s, agreement: a, pass };
  });
}

// Fixed seeded shuffle (mulberry32 + Fisher-Yates); does not mutate its input.
export function seededShuffle(items, seed) {
  let t = seed >>> 0;
  const rnd = () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Opaque sNN ids in order; byOpaque maps back to the caller's ids.
export function opaqueSessions(items) {
  const sessions = [];
  const byOpaque = {};
  items.forEach((it, i) => {
    const id = `s${String(i + 1).padStart(2, "0")}`;
    sessions.push({ id, messages: it.messages });
    byOpaque[id] = it.id;
  });
  return { sessions, byOpaque };
}

// ---- the written reference set ----------------------------------------------

export function loadReference(dir) {
  const files = readdirSync(dir).filter((f) => /\.(it|en)\.json$/.test(f)).sort();
  const sessions = [];
  const seen = new Set();
  for (const f of files) {
    const doc = JSON.parse(readFileSync(join(dir, f), "utf8"));
    for (const s of doc.sessions ?? []) {
      if (seen.has(s.id)) throw new Error(`duplicate session id ${s.id} in ${f}`);
      seen.add(s.id);
      sessions.push({ id: s.id, lang: doc.lang, practice: doc.practice, kind: s.kind, messages: s.messages, expected: s.expected });
    }
  }
  return { sessions };
}

const perPracticeCounts = (answers, expected) =>
  Object.fromEntries(IDS.map((id) => [id, agreement(answers, expected, id)]));

// Classify every reference session once, in a seeded mixed order, behind opaque ids.
export async function runAgreement({ dir = DEFAULT_DIR, call, seed = SHUFFLE_SEED }) {
  const { sessions: all } = loadReference(dir);
  const mixed = seededShuffle(all, seed);
  const { sessions, byOpaque } = opaqueSessions(mixed);
  const answers = await classifyPractices({ rubric: RUBRIC, practices: MODEL_PRACTICE_CANDIDATES, sessions }, { call });
  const byId = Object.fromEntries(mixed.map((s) => [s.id, s]));
  const expectedAll = {};
  const langs = {};
  for (const [op, real] of Object.entries(byOpaque)) {
    expectedAll[op] = byId[real].expected;
    (langs[byId[real].lang] ??= {})[op] = byId[real].expected;
  }
  const perPractice = perPracticeCounts(answers, expectedAll);
  const byLang = Object.fromEntries(Object.entries(langs).map(([l, exp]) => [l, perPracticeCounts(answers, exp)]));
  const mismatches = [];
  for (const [op, real] of Object.entries(byOpaque)) {
    for (const id of IDS) {
      const got = answers[op]?.[id];
      if (got !== byId[real].expected[id]) mismatches.push({ id: real, practice: id, expected: byId[real].expected[id], got });
    }
  }
  return { perPractice, byLang, mismatches };
}

// ---- stability on the developer's own logs ----------------------------------

const lastTs = (session) => {
  let last = null;
  for (const m of Array.isArray(session?.messages) ? session.messages : []) {
    const t = m?.ts ? Date.parse(m.ts) : NaN;
    if (Number.isFinite(t) && (last === null || t > last)) last = t;
  }
  return last;
};

// The `limit` most recent eligible sessions (>= 2 own messages and a timestamp),
// after dropping any session whose working directory contains an excluded
// substring. Returns { sessions: [{ id: sNN, messages }], excluded: count }.
export function recentEligible(parsed, { limit = STABILITY_SESSIONS, excludePaths = [], tz = DEFAULT_TZ } = {}) {
  const picks = [];
  let excluded = 0;
  for (const { session } of eachSession(parsed, tz)) {
    const cwds = [session?.cwdRaw, session?.cwdRedacted].filter((c) => typeof c === "string");
    if (excludePaths.some((x) => x && cwds.some((c) => c.includes(x)))) { excluded++; continue; }
    const ts = lastTs(session);
    if (ts === null) continue;
    const messages = personMessages(session);
    if (messages.length < 2) continue;
    picks.push({ ts, messages });
  }
  picks.sort((a, b) => b.ts - a.ts);
  const sessions = picks.slice(0, limit).map((p, i) => ({ id: `s${String(i + 1).padStart(2, "0")}`, messages: p.messages }));
  return { sessions, excluded };
}

export async function runStability({ sessions, call }) {
  const input = { rubric: RUBRIC, practices: MODEL_PRACTICE_CANDIDATES, sessions };
  const runA = await classifyPractices(input, { call });
  const runB = await classifyPractices(input, { call });
  const st = {};
  const trueIn = {};
  for (const id of IDS) {
    st[id] = stability(runA, runB, id);
    const count = (r) => Object.values(r).filter((a) => a?.[id] === true).length;
    trueIn[id] = { a: count(runA), b: count(runB) };
  }
  return { stability: st, trueIn, runA, runB };
}

// ---- the model transport -----------------------------------------------------

// The person's own model through the Claude Code CLI, from a fresh empty cwd.
export function claudeCliCall({ model = MODEL, run = execFileAsync } = {}) {
  return async ({ system, user }) => {
    const cwd = mkdtempSync(join(tmpdir(), "practices-gate-"));
    try {
      const args = [
        "-p", "--model", model, "--setting-sources", "", "--strict-mcp-config", "--tools", "",
        "--system-prompt", system, "--output-format", "json", user,
      ];
      let stdout;
      try {
        ({ stdout } = await run("claude", args, { cwd, maxBuffer: 64 * 1024 * 1024 }));
      } catch (e) {
        throw new Error(`claude CLI failed: ${String(e.stderr || e.message).trim()}`);
      }
      const doc = JSON.parse(stdout);
      if (doc.is_error) throw new Error(`claude CLI error: ${String(doc.result ?? "")}`);
      return String(doc.result);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  };
}

// ---- CLI ---------------------------------------------------------------------

const pct = (r) => `${(r * 100).toFixed(1)}%`;

function chooseCall(argv) {
  const flag = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
  const key = process.env.ANTHROPIC_API_KEY;
  const via = flag("via") ?? (key ? "api" : "claude");
  if (via === "api") {
    if (!key) throw new Error("--via api needs ANTHROPIC_API_KEY");
    return anthropicCall(key);
  }
  if (via === "claude") return claudeCliCall({ model: MODEL });
  throw new Error(`unknown --via ${via}; expected api or claude`);
}

// The only thing a stability failure may print: no quoted text from the model or the logs.
const safeError = (e) => String(e?.message ?? e).replace(/"[^"]*"/g, '"..."').replace(/\s+/g, " ").slice(0, 200);

export function stabilityOut(r) {
  return { rubric: RUBRIC, stability: r.stability, trueIn: r.trueIn, runA: r.runA, runB: r.runB };
}

async function main(argv) {
  const sub = argv[0];
  const flag = (n, d = null) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
  };
  const flags = (n) => argv.flatMap((a, i) => (a === `--${n}` && argv[i + 1] ? [argv[i + 1]] : []));
  const has = (n) => argv.includes(`--${n}`);
  const out = flag("out");

  if (sub === "stability") {
    const root = flag("root", join(homedir(), ".claude", "projects"));
    if (!existsSync(root)) throw new Error(`No logs at ${root}.`);
    const sources = {
      opencode: { root: flag("opencode-root"), disabled: has("no-opencode"), json: has("opencode-json") },
      codex: { root: flag("codex-root"), disabled: has("no-codex") },
      pi: { root: flag("pi-root"), disabled: has("no-pi") },
      cursor: { root: flag("cursor-root"), disabled: has("no-cursor") },
      kimi: { root: flag("kimi-root"), disabled: has("no-kimi") },
    };
    const parsed = readAllSources({ claudeRoot: root, sources });
    const { sessions, excluded } = recentEligible(parsed, { excludePaths: flags("exclude-path") });
    console.log(`excluded by path: ${excluded}; sessions classified: ${sessions.length}`);
    if (!sessions.length) throw new Error("no eligible sessions");
    let r;
    try {
      r = await runStability({ sessions, call: chooseCall(argv) });
    } catch (e) {
      throw new Error(safeError(e));
    }
    for (const id of IDS) {
      const s = r.stability[id];
      console.log(`${id}: stability ${s.same}/${s.of} (${pct(s.rate)}); true in run A ${r.trueIn[id].a}, run B ${r.trueIn[id].b}`);
    }
    if (out) writeFileSync(out, JSON.stringify(stabilityOut(r), null, 2));
    return;
  }

  if (sub === "agreement") {
    const dir = flag("dir", DEFAULT_DIR);
    if (!existsSync(dir)) throw new Error(`No reference set at ${dir}.`);
    const r = await runAgreement({ dir, call: chooseCall(argv) });
    for (const id of IDS) {
      const a = r.perPractice[id];
      const langs = Object.keys(r.byLang).sort().map((l) => `${l} ${r.byLang[l][id].matched}/${r.byLang[l][id].of}`).join(", ");
      console.log(`${id}: agreement ${a.matched}/${a.of} (${pct(a.rate)}); ${langs}`);
    }
    const payload = { rubric: RUBRIC, agreement: r.perPractice, byLang: r.byLang, mismatches: r.mismatches };
    if (out) writeFileSync(out, JSON.stringify(payload, null, 2));
    else for (const m of r.mismatches) console.error(`mismatch ${m.id} ${m.practice}: expected ${m.expected}, got ${m.got}`);
    return;
  }

  if (sub === "report") {
    const st = JSON.parse(readFileSync(flag("stability"), "utf8")).stability;
    const ag = JSON.parse(readFileSync(flag("agreement"), "utf8")).agreement;
    for (const p of gateReport({ stability: st, agreement: ag })) {
      const f = (v) => (v === null ? "missing" : pct(v));
      console.log(`${p.id}: stability ${f(p.stability)}, agreement ${f(p.agreement)}, ${p.pass ? "pass" : "FAIL"}`);
    }
    return;
  }

  throw new Error("Usage: practices-gate.mjs stability | agreement | report (see the header of this file)");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
