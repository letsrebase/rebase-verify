import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGREEMENT_MIN,
  STABILITY_MIN,
  agreement,
  stability,
  gateReport,
  seededShuffle,
  opaqueSessions,
  loadReference,
  runAgreement,
  runStability,
  recentEligible,
  claudeCliCall,
  stabilityOut,
} from "../scripts/practices-gate.mjs";
import { MODEL_PRACTICE_CANDIDATES } from "../src/practices-rules.mjs";

const IDS = MODEL_PRACTICE_CANDIDATES.map((p) => p.id);
const six = (v) => Object.fromEntries(IDS.map((id) => [id, v]));

test("thresholds are 0.9", () => {
  assert.equal(STABILITY_MIN, 0.9);
  assert.equal(AGREEMENT_MIN, 0.9);
});

test("agreement counts the matches of one practice", () => {
  const p = IDS[0];
  const answers = { s01: six(true), s02: six(false), s03: six(true), s04: six(false) };
  const expected = { s01: six(true), s02: six(true), s03: six(false), s04: six(false) };
  assert.deepEqual(agreement(answers, expected, p), { matched: 2, of: 4, rate: 0.5 });
});

test("agreement: a session with no answer is a mismatch", () => {
  const p = IDS[0];
  assert.deepEqual(agreement({ s01: six(true) }, { s01: six(true), s02: six(false) }, p), { matched: 1, of: 2, rate: 0.5 });
});

test("agreement of nothing is of 0, rate 0", () => {
  assert.deepEqual(agreement({}, {}, IDS[0]), { matched: 0, of: 0, rate: 0 });
});

const runs = (diff) => {
  const a = {};
  const b = {};
  for (let i = 0; i < 40; i++) {
    const id = `s${String(i + 1).padStart(2, "0")}`;
    a[id] = six(true);
    b[id] = { ...six(true), ...(i < diff ? { [IDS[0]]: false } : {}) };
  }
  return [a, b];
};

test("stability 36 of 40 is 0.9 and passes", () => {
  const [a, b] = runs(4);
  const s = stability(a, b, IDS[0]);
  assert.deepEqual(s, { same: 36, of: 40, rate: 0.9 });
  const r = gateReport({ stability: { [IDS[0]]: s }, agreement: { [IDS[0]]: { matched: 9, of: 10, rate: 0.9 } } });
  assert.equal(r.find((x) => x.id === IDS[0]).pass, true);
});

test("stability 35 of 40 fails", () => {
  const [a, b] = runs(5);
  const s = stability(a, b, IDS[0]);
  assert.equal(s.same, 35);
  assert.ok(s.rate < STABILITY_MIN);
  const r = gateReport({ stability: { [IDS[0]]: s }, agreement: { [IDS[0]]: { matched: 10, of: 10, rate: 1 } } });
  assert.equal(r.find((x) => x.id === IDS[0]).pass, false);
});

test("stability: a session missing from the second run is a difference", () => {
  const [a, b] = runs(0);
  delete b.s01;
  assert.equal(stability(a, b, IDS[0]).same, 39);
});

test("pass needs both measures", () => {
  const good = { same: 40, of: 40, rate: 1 };
  const goodA = { matched: 10, of: 10, rate: 1 };
  const badA = { matched: 8, of: 10, rate: 0.8 };
  const r = gateReport({
    stability: { [IDS[0]]: good, [IDS[1]]: good, [IDS[2]]: { same: 30, of: 40, rate: 0.75 } },
    agreement: { [IDS[0]]: goodA, [IDS[1]]: badA, [IDS[2]]: goodA },
  });
  const by = Object.fromEntries(r.map((x) => [x.id, x]));
  assert.deepEqual(by[IDS[0]], { id: IDS[0], stability: 1, agreement: 1, pass: true });
  assert.equal(by[IDS[1]].pass, false);
  assert.equal(by[IDS[2]].pass, false);
});

test("a practice missing a reference or a stability run is pass: false, numbers null", () => {
  const good = { same: 40, of: 40, rate: 1 };
  const goodA = { matched: 10, of: 10, rate: 1 };
  const r = gateReport({ stability: { [IDS[0]]: good }, agreement: { [IDS[1]]: goodA } });
  assert.equal(r.length, IDS.length);
  const by = Object.fromEntries(r.map((x) => [x.id, x]));
  assert.deepEqual(by[IDS[0]], { id: IDS[0], stability: 1, agreement: null, pass: false });
  assert.deepEqual(by[IDS[1]], { id: IDS[1], stability: null, agreement: 1, pass: false });
  assert.equal(by[IDS[5]].pass, false);
  // a measure over zero sessions is not a measure
  const z = gateReport({ stability: { [IDS[0]]: good }, agreement: { [IDS[0]]: { matched: 0, of: 0, rate: 0 } } });
  assert.equal(z.find((x) => x.id === IDS[0]).pass, false);
});

test("seededShuffle is deterministic, a permutation, and does not mutate", () => {
  const items = Array.from({ length: 30 }, (_, i) => i);
  const copy = items.slice();
  const a = seededShuffle(items, 7);
  const b = seededShuffle(items, 7);
  assert.deepEqual(items, copy);
  assert.deepEqual(a, b);
  assert.deepEqual([...a].sort((x, y) => x - y), items);
  assert.notDeepEqual(a, items);
  assert.notDeepEqual(seededShuffle(items, 8), a);
});

test("seededShuffle mixes kinds: sessions grouped by practice and kind do not stay grouped", () => {
  const items = [];
  for (const p of IDS) for (const kind of ["positive", "near_miss"]) for (let i = 0; i < 8; i++) items.push({ p, kind });
  const out = seededShuffle(items, 20261118);
  let runs = 0;
  for (let i = 1; i < out.length; i++) if (out[i].p === out[i - 1].p && out[i].kind === out[i - 1].kind) runs++;
  assert.ok(runs < items.length / 4, `still grouped: ${runs} adjacent equal pairs`);
  const firstBatch = out.slice(0, 10);
  assert.ok(new Set(firstBatch.map((x) => x.kind)).size === 2);
  assert.ok(new Set(firstBatch.map((x) => x.p)).size >= 3);
});

test("opaqueSessions maps to sNN in order and keeps the real ids apart", () => {
  const { sessions, byOpaque } = opaqueSessions([
    { id: "alt-pos-it-1", messages: ["a", "b"] },
    { id: "alt-neg-en-2", messages: ["c", "d"] },
  ]);
  assert.deepEqual(sessions, [{ id: "s01", messages: ["a", "b"] }, { id: "s02", messages: ["c", "d"] }]);
  assert.deepEqual(byOpaque, { s01: "alt-pos-it-1", s02: "alt-neg-en-2" });
});

function writeSet(dir, langs = ["it", "en"]) {
  for (const lang of langs) {
    for (const p of IDS) {
      const sessions = [];
      for (const kind of ["positive", "near_miss"]) {
        for (let i = 1; i <= 2; i++) {
          sessions.push({
            id: `${p}-${kind}-${lang}-${i}`,
            kind,
            messages: [`first message ${i}`, "second"],
            expected: { ...six(false), [p]: kind === "positive" },
          });
        }
      }
      writeFileSync(join(dir, `${p}.${lang}.json`), JSON.stringify({ rubric: "rebase-practices/v1", practice: p, lang, sessions }));
    }
  }
}

test("runAgreement never sends a descriptive id and scores against the expected answers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-ref-"));
  try {
    writeSet(dir);
    const set = loadReference(dir);
    assert.equal(set.sessions.length, IDS.length * 2 * 4);
    const users = [];
    // a fake model that answers every session false
    const call = async ({ user }) => {
      users.push(user);
      const { sessions } = JSON.parse(user);
      return JSON.stringify(Object.fromEntries(sessions.map((s) => [s.id, six(false)])));
    };
    const r = await runAgreement({ dir, call });
    const sent = users.join("\n");
    for (const x of set.sessions) assert.ok(!sent.includes(x.id), `descriptive id ${x.id} leaks`);
    assert.ok(!/near_miss|"kind"|"expected"/.test(sent), "no kind or expected answer leaks");
    for (const u of users) for (const s of JSON.parse(u).sessions) assert.match(s.id, /^s\d\d$/);
    // all false: wrong only on the positives of each practice (2 positive sessions per practice per language)
    for (const p of IDS) {
      assert.equal(r.perPractice[p].of, 48);
      assert.equal(r.perPractice[p].matched, 48 - 4);
      assert.equal(r.byLang.it[p].of, 24);
      assert.equal(r.byLang.en[p].matched, 24 - 2);
    }
    assert.equal(r.mismatches.length, IDS.length * 4);
    assert.deepEqual(Object.keys(r.mismatches[0]).sort(), ["expected", "got", "id", "practice"]);
    assert.ok(r.mismatches.every((m) => m.id.includes("positive")));
    // the batches mix practices and kinds
    const firstIds = JSON.parse(users[0]).sessions.length;
    assert.equal(firstIds, 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadReference rejects a duplicate id", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-ref-"));
  try {
    writeSet(dir, ["it"]);
    const f = join(dir, `${IDS[0]}.en.json`);
    writeFileSync(f, JSON.stringify({ rubric: "x", practice: IDS[0], lang: "en", sessions: [{ id: `${IDS[0]}-positive-it-1`, kind: "positive", messages: ["a", "b"], expected: six(false) }] }));
    assert.throws(() => loadReference(dir), /duplicate/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const mkSession = (id, stamps, cwd = "/home/x/p", redacted = "~/p") => ({
  sessionId: id, source: "claude-code", cwdRedacted: redacted, cwdRaw: cwd,
  messages: stamps.map((ts, i) => ({ role: "user", textRedacted: `hello ${id} ${i}`, ts })),
});

test("recentEligible takes the most recent sessions with two own messages and a timestamp", () => {
  const parsed = {
    sessions: [
      mkSession("old", ["2026-01-01T10:00:00Z", "2026-01-01T10:05:00Z"]),
      mkSession("new", ["2026-03-01T10:00:00Z", "2026-03-01T10:05:00Z"]),
      mkSession("mid", ["2026-02-01T10:00:00Z", "2026-02-01T10:05:00Z"]),
      mkSession("one", ["2026-04-01T10:00:00Z"]),
      mkSession("notime", [undefined, undefined]),
    ],
  };
  const got = recentEligible(parsed, { limit: 2 });
  assert.equal(got.excluded, 0);
  assert.deepEqual(got.sessions.map((s) => s.id), ["s01", "s02"]);
  assert.ok(got.sessions[0].messages[0].includes("hello new"));
  assert.ok(got.sessions[1].messages[0].includes("hello mid"));
  assert.equal(recentEligible(parsed, { limit: 40 }).sessions.length, 3);
});

test("recentEligible drops excluded paths before picking the most recent, and counts them", () => {
  const parsed = {
    sessions: [
      mkSession("secret-new", ["2026-05-01T10:00:00Z", "2026-05-01T10:05:00Z"], "/home/x/client-acme/app", "~/client-acme/app"),
      mkSession("secret-raw-only", ["2026-04-20T10:00:00Z", "2026-04-20T10:05:00Z"], "/home/x/other/zzz-private", "~/other/x"),
      mkSession("keep-new", ["2026-03-01T10:00:00Z", "2026-03-01T10:05:00Z"]),
      mkSession("keep-old", ["2026-02-01T10:00:00Z", "2026-02-01T10:05:00Z"]),
    ],
  };
  const got = recentEligible(parsed, { limit: 2, excludePaths: ["client-acme", "zzz-private"] });
  assert.equal(got.excluded, 2);
  assert.deepEqual(got.sessions.map((s) => s.messages[0]), ["hello keep-new 0", "hello keep-old 0"]);
  assert.deepEqual(Object.keys(got.sessions[0]).sort(), ["id", "messages"]);
  assert.equal(recentEligible(parsed, { limit: 2, excludePaths: [] }).sessions[0].messages[0], "hello secret-new 0");
});

test("runStability runs the classification twice on the same sessions and counts per practice", async () => {
  const sessions = Array.from({ length: 40 }, (_, i) => ({ id: `s${String(i + 1).padStart(2, "0")}`, messages: ["a", "b"] }));
  let n = 0;
  const call = async ({ user }) => {
    n++;
    const run = n <= 4 ? 1 : 2; // 40 sessions = 4 batches of 10
    const { sessions: ss } = JSON.parse(user);
    return JSON.stringify(
      Object.fromEntries(ss.map((s, k) => [s.id, { ...six(true), ...(run === 2 && k === 0 ? { [IDS[0]]: false } : {}) }])),
    );
  };
  const r = await runStability({ sessions, call });
  assert.equal(n, 8);
  assert.deepEqual(r.stability[IDS[0]], { same: 36, of: 40, rate: 0.9 });
  assert.deepEqual(r.stability[IDS[1]], { same: 40, of: 40, rate: 1 });
  assert.deepEqual(r.trueIn[IDS[0]], { a: 40, b: 36 });
  assert.equal(Object.keys(r.runA).length, 40);
});

test("the stability out file holds booleans and numbers only, no message", async () => {
  const sessions = [{ id: "s01", messages: ["PRIVATE-TEXT one", "PRIVATE-TEXT two"] }, { id: "s02", messages: ["x", "y"] }];
  const call = async ({ user }) =>
    JSON.stringify(Object.fromEntries(JSON.parse(user).sessions.map((s) => [s.id, six(false)])));
  const out = JSON.stringify(stabilityOut(await runStability({ sessions, call })));
  assert.ok(!out.includes("PRIVATE-TEXT"));
  assert.deepEqual(Object.keys(JSON.parse(out)).sort(), ["rubric", "runA", "runB", "stability", "trueIn"]);
  assert.deepEqual(Object.keys(JSON.parse(out).runA).sort(), ["s01", "s02"]);
});

test("claudeCliCall spawns claude from an empty temp cwd with the exact flags and returns .result", async () => {
  const seen = [];
  const run = async (cmd, args, opts) => {
    seen.push({ cmd, args, opts });
    return { stdout: JSON.stringify({ is_error: false, result: '{"s01":{}}' }), stderr: "" };
  };
  const call = claudeCliCall({ model: "m-1", run });
  const out = await call({ system: "SYS", user: "USER" });
  assert.equal(out, '{"s01":{}}');
  assert.equal(seen[0].cmd, "claude");
  assert.deepEqual(seen[0].args, [
    "-p", "--model", "m-1", "--setting-sources", "", "--strict-mcp-config", "--tools", "",
    "--system-prompt", "SYS", "--output-format", "json", "USER",
  ]);
  assert.ok(seen[0].opts.cwd.startsWith(tmpdir()));
  assert.notEqual(seen[0].opts.cwd, process.cwd());
});

test("claudeCliCall throws on is_error and on a failed exit, with stderr", async () => {
  const bad = claudeCliCall({ model: "m", run: async () => ({ stdout: JSON.stringify({ is_error: true, result: "nope" }), stderr: "" }) });
  await assert.rejects(() => bad({ system: "s", user: "u" }), /nope/);
  const fail = claudeCliCall({ model: "m", run: async () => { throw Object.assign(new Error("exit 1"), { code: 1, stderr: "auth broke" }); } });
  await assert.rejects(() => fail({ system: "s", user: "u" }), /auth broke/);
});
