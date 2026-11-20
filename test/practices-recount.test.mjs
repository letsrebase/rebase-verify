// At submit the code practices are recounted from the logs, as the other blocks
// are re-derived: a claim above the recount is an excess claim. The model
// practices cannot be recounted and are left to the structure check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assessAgainstLogs } from "../src/consistency.mjs";
import { computeCodePractices, practicesBlock, recordedPracticesTz } from "../src/practices.mjs";

const edit = (path) => ({ tool: "Edit", path });
const bash = (cmd) => ({ tool: "Bash", cmd });

function session(id, events, ts) {
  const messages = [];
  events.forEach((e, i) => {
    const callId = `${id}-${i}`;
    messages.push({ role: "assistant", ts, textRedacted: "", toolUses: [{ id: callId, name: e.tool, path: e.path ?? "", cmd: e.cmd ?? "", q: "" }], toolResults: [] });
    messages.push({ role: "user", ts, textRedacted: "", toolUses: [], toolResults: [{ forId: callId, isError: false, bytes: 0 }] });
  });
  return { source: "claude-code", sessionId: id, cwdRaw: "", cwdRedacted: "/h/p/x", messages };
}

// Two sessions with a commit, one checked after its last edit; the second sits
// on a month edge (31 March 23:30 UTC is April in Rome).
const parsed = {
  source: "claude-code",
  sessions: [
    session("a", [edit("src/a.ts"), bash("npm test"), bash("git commit -m x")], "2026-03-10T10:00:00.000Z"),
    session("b", [edit("src/b.ts"), bash("npm test"), bash("git commit -m y")], "2026-03-31T23:30:00.000Z"),
  ],
};

// The submit wiring: recount in the zone the block recorded, then assess.
const profileFor = (tz, edit = (b) => b) => ({ practices: edit(structuredClone(practicesBlock(computeCodePractices(parsed, { tz }).items, { tz }))) });
const recount = (profile) => assessAgainstLogs(profile, [], { practices: computeCodePractices(parsed, { tz: recordedPracticesTz(profile) }) });
const item = (b, id) => b.items.find((x) => x.id === id);

test("an honest block recounts to the same numbers, in the zone it recorded", () => {
  for (const tz of ["UTC", "Europe/Rome"]) {
    const p = profileFor(tz);
    assert.equal(item(p.practices, "checks_before_commit").months, tz === "UTC" ? 1 : 2);
    assert.deepEqual(recount(p), { issues: [], warnings: [], excessClaims: 0 });
  }
});

test("a code count raised by hand is an excess claim naming the practice and the count", () => {
  for (const k of ["seen", "of", "products", "months"]) {
    const p = profileFor("Europe/Rome", (b) => { item(b, "checks_before_commit")[k] += 1; return b; });
    const r = recount(p);
    assert.equal(r.excessClaims, 1, k);
    assert.match(r.issues[0], new RegExp(`^practices\\.checks_before_commit: claims ${k} \\d+, the logs recount \\d+`));
  }
});

test("a code practice no session in the logs could show is an excess claim on every count", () => {
  // No check failed in either session, so the recount has no failure_reproduced_before_fix.
  const p = profileFor("UTC", (b) => { b.items.push({ id: "failure_reproduced_before_fix", method: "code", seen: 1, of: 1, products: 1, months: 1 }); return b; });
  assert.deepEqual(recount(p).issues.map((i) => i.split(",")[0]), ["seen", "of", "products", "months"].map((k) => `practices.failure_reproduced_before_fix: claims ${k} 1`));
});

test("model practices are not recounted; a code id relabelled as model still is", () => {
  const model = profileFor("UTC", (b) => { b.items.push({ id: "limits_scope", method: "model", seen: 2, of: 2, products: 1, months: 1 }); return b; });
  assert.equal(recount(model).excessClaims, 0);
  const relabelled = profileFor("UTC", (b) => { Object.assign(item(b, "checks_before_commit"), { method: "model", seen: 5, of: 5 }); return b; });
  assert.equal(recount(relabelled).excessClaims, 2);
});

test("without a recount nothing is checked; with logs that show nothing, every claim is in excess", () => {
  const p = profileFor("UTC");
  assert.equal(assessAgainstLogs(p, [], {}).excessClaims, 0);
  assert.ok(assessAgainstLogs(p, [], { practices: null }).excessClaims > 0);
});

test("an invalid or absent recorded zone falls back to UTC", () => {
  assert.equal(recordedPracticesTz({ practices: { timezone: "Mars/Olympus" } }), "UTC");
  assert.equal(recordedPracticesTz({}), "UTC");
  assert.equal(recordedPracticesTz({ practices: { timezone: "Europe/Rome" } }), "Europe/Rome");
});
