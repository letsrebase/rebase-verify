// Validation of the model's answers, the merged block, the detail file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { validateModelAnswers, computeModelPractices, practicesDetail, mergeModelPractices, practicesBlock } from "../src/practices.mjs";
import { buildPayload } from "../src/submit.mjs";
import { baseProfile } from "./factories.mjs";

const ids = ["asks_for_alternatives", "raises_risks"];
const sample = [
  { id: "s01", session: "real-a", date: "2026-03-05", product: "p1", month: "2026-03" },
  { id: "s02", session: "real-b", date: "2026-04-05", product: "p2", month: "2026-04" },
  { id: "s03", session: "real-c", date: "2026-04-06", product: "p2", month: "2026-04" },
];
const row = (a, b) => ({ asks_for_alternatives: a, raises_risks: b });
const full = () => ({ s01: row(true, false), s02: row(true, true), s03: row(false, false) });

test("validateModelAnswers accepts a full set", () => {
  assert.deepEqual(validateModelAnswers(full(), sample, ids), { ok: true });
});

test("validateModelAnswers refuses each malformed shape, naming session and id", () => {
  const bad = (mut, re) => {
    const a = full(); mut(a);
    const r = validateModelAnswers(a, sample, ids);
    assert.equal(r.ok, false);
    assert.match(r.error, re);
  };
  bad((a) => { delete a.s02; }, /s02/);
  bad((a) => { delete a.s01.raises_risks; }, /s01.*raises_risks/);
  bad((a) => { a.s01.raises_risks = "yes"; }, /s01.*raises_risks/);
  bad((a) => { a.s03.asks_for_alternatives = 1; }, /s03.*asks_for_alternatives/);
  bad((a) => { a.s01.reason = "because"; }, /s01.*reason/);
  bad((a) => { a.s99 = row(true, true); }, /s99/);
  for (const x of [null, [], "x", 3]) assert.equal(validateModelAnswers(x, sample, ids).ok, false);
});

test("computeModelPractices counts seen, products and months over the sessions where it was seen", () => {
  const items = computeModelPractices(full(), sample, ids);
  assert.deepEqual(items, [
    { id: "asks_for_alternatives", method: "model", seen: 2, of: 3, products: 2, months: 2 },
    { id: "raises_risks", method: "model", seen: 1, of: 3, products: 1, months: 1 },
  ]);
});

test("a practice nobody showed carries 0 seen and 0 months; an empty sample gives no items", () => {
  const a = { s01: row(false, false), s02: row(false, false), s03: row(false, false) };
  assert.deepEqual(computeModelPractices(a, sample, ids)[0], { id: "asks_for_alternatives", method: "model", seen: 0, of: 3, products: 0, months: 0 });
  assert.deepEqual(computeModelPractices({}, [], ids), []);
});

test("practicesDetail maps opaque ids back to real sessions", () => {
  assert.deepEqual(practicesDetail(full(), sample)[1], { session: "real-b", date: "2026-04-05", product: "p2", answers: row(true, true) });
  assert.equal(practicesDetail(full(), sample).length, 3);
});

test("mergeModelPractices appends model items after the code items in one block", () => {
  const code = practicesBlock([{ id: "checks_before_commit", method: "code", seen: 1, of: 2, products: 1, months: 1 }], { tz: "UTC" });
  const r = mergeModelPractices(code, full(), sample, ids, { tz: "UTC" });
  assert.deepEqual(r.block.items.map((i) => i.id), ["checks_before_commit", "asks_for_alternatives", "raises_risks"]);
  assert.equal(r.block.rubric, code.rubric);
  assert.equal(r.detail.length, 3);
  const none = mergeModelPractices(null, full(), sample, ids, { tz: "Europe/Rome" });
  assert.equal(none.block.timezone, "Europe/Rome");
  assert.equal(none.block.items.length, 2);
  assert.throws(() => mergeModelPractices(code, {}, sample, ids, { tz: "UTC" }), /s01/);
});

test("practices-detail.json never reaches the submit payload", () => {
  const p = baseProfile();
  p.practices = mergeModelPractices(null, full(), sample, ids, { tz: "UTC" }).block;
  const sent = JSON.stringify(buildPayload(p));
  for (const s of ["real-a", "real-b", "real-c", "s01", "answers"]) assert.ok(!sent.includes(`"${s}"`), s);
});

function finalizeWith(files) {
  const home = mkdtempSync(join(tmpdir(), "pm-"));
  const cwd = mkdtempSync(join(tmpdir(), "pm-cwd-"));
  try {
    const root = join(home, "projects", "-h-p-x");
    mkdirSync(root, { recursive: true });
    const lines = ["a", "b", "c"].map((t, i) => JSON.stringify({ type: "user", sessionId: "s", cwd: "/h/p/x", timestamp: `2026-05-01T10:0${i}:00.000Z`, message: { role: "user", content: t } }));
    writeFileSync(join(root, "s.jsonl"), lines.join("\n") + "\n");
    mkdirSync(join(cwd, "out"));
    writeFileSync(join(cwd, "out", "narrative.json"), "{}");
    for (const [n, c] of Object.entries(files)) writeFileSync(join(cwd, "out", n), c);
    const bin = new URL("../bin/rebase-verify.mjs", import.meta.url).pathname;
    const r = spawnSync(process.execPath, [bin, "finalize", "--root", join(home, "projects"), "--no-opencode", "--no-codex", "--no-pi", "--no-cursor", "--no-kimi"], { cwd, encoding: "utf8", timeout: 120000, env: { ...process.env, HOME: home, USERPROFILE: home, XDG_DATA_HOME: join(home, "x") } });
    return { r, candidate: existsSync(join(cwd, "out", "candidate.json")), detail: existsSync(join(cwd, "out", "practices-detail.json")) };
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("finalize with a practices.json but no sample file exits 2 and writes no candidate", () => {
  const { r, candidate } = finalizeWith({ "practices.json": "{}" });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /practices-sample\.json/);
  assert.ok(!candidate);
});

test("finalize with a bad answers file exits 2, naming the session, and writes no candidate", () => {
  const { r, candidate, detail } = finalizeWith({
    "practices.json": JSON.stringify({ s01: { x: true } }),
    "practices-sample.json": JSON.stringify([{ id: "s01", session: "s", date: "2026-05-01", product: "x", month: "2026-05" }]),
  });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /s01/);
  assert.ok(!candidate && !detail);
});
