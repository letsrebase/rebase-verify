// The practices block in the profile: assembly, structure check, markdown.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assessStructure } from "../src/consistency.mjs";
import { assembleProfile, renderMarkdown } from "../src/profile.mjs";
import { practicesBlock } from "../src/practices.mjs";
import { baseProfile } from "./factories.mjs";

const item = (over = {}) => ({ id: "checks_before_commit", method: "code", seen: 18, of: 25, products: 3, months: 4, ...over });
const block = (items, over = {}) => ({ rubric: "rebase-practices/v1", timezone: "UTC", items, ...over });
const withBlock = (b) => ({ ...baseProfile(), practices: b });
const issuesOf = (p) => assessStructure(p).issues.filter((i) => i.startsWith("practices"));

test("the block is absent on older profiles and the frozen fixture passes unmodified", () => {
  const p = baseProfile();
  p.volume = { products: 1, sessions: 59, instructions: 3800 };
  assert.deepEqual(assessStructure(p).issues, []);
  assert.equal(assembleProfile({ contact: null, projects: [], narrative: null, fingerprint: null, forensics: null }).practices, null);
});

test("an honest block passes", () => {
  assert.deepEqual(issuesOf(withBlock(block([item(), item({ id: "reviews_changes", seen: 1, of: 1, products: 1, months: 1 })]))), []);
});

test("assessStructure refuses a malformed block, naming the practice and the rule", () => {
  const p = withBlock(block([item({ seen: 5, of: 4, products: 1, months: 1 })]));
  assert.ok(assessStructure(p).issues.some((i) => /practices\.checks_before_commit/.test(i) && /seen/.test(i)));
});

const cases = {
  "rubric other": () => withBlock(block([item()], { rubric: "other/v1" })),
  "method model for a code id": () => withBlock(block([item({ method: "model" })])),
  "id unknown": () => withBlock(block([item({ id: "writes_poems" })])),
  "id twice": () => withBlock(block([item(), item()])),
  "of > volume.sessions": () => withBlock(block([item({ seen: 5, of: 237 })])),
  "products > volume.products": () => withBlock(block([item({ products: 31, seen: 31, of: 40 })])),
  "products > seen": () => withBlock(block([item({ seen: 2, products: 3, months: 1 })])),
  "months > seen": () => withBlock(block([item({ seen: 2, products: 1, months: 3 })])),
  "months 0 with seen 1": () => withBlock(block([item({ seen: 1, of: 1, products: 1, months: 0 })])),
  "months > window": () => withBlock(block([item({ seen: 9, products: 1, months: 7 })])),
  "seen a bool": () => withBlock(block([item({ seen: true })])),
  "seen 1.5": () => withBlock(block([item({ seen: 1.5 })])),
  "items not a list": () => withBlock(block("checks")),
  "timezone invalid": () => withBlock(block([item()], { timezone: "Mars/Olympus" })),
  "timezone != intensity.timezone": () => ({ ...withBlock(block([item()], { timezone: "Europe/Rome" })), intensity: { timezone: "UTC" } }),
};
for (const [name, make] of Object.entries(cases)) {
  test(`assessStructure rule: ${name}`, () => {
    assert.equal(issuesOf(make()).length, 1, issuesOf(make()).join("\n"));
  });
}

test("practicesBlock wraps items with the rubric and zone, and is null with no items", () => {
  assert.deepEqual(practicesBlock([item()], { tz: "Europe/Rome" }), block([item()], { timezone: "Europe/Rome" }));
  assert.equal(practicesBlock([], { tz: "UTC" }), null);
  assert.equal(practicesBlock(null, { tz: "UTC" }), null);
});

test("assembleProfile carries the block", () => {
  const b = block([item()]);
  assert.deepEqual(assembleProfile({ contact: null, projects: [], narrative: null, fingerprint: null, forensics: null, practices: b }).practices, b);
});

test("renderMarkdown prints counts with the method per row, no total, no percentage", () => {
  const md = renderMarkdown(withBlock(block([item(), item({ id: "reviews_changes", seen: 1, of: 1, products: 1, months: 1 })])));
  assert.ok(md.includes("## How the work is done"), md);
  assert.ok(/checks_before_commit.*in 18 of 25 sessions.*3 products.*4 months.*counted by code/.test(md), md);
  assert.ok(/reviews_changes.*in 1 of 1 session.*1 product.*1 month/.test(md), md);
  const section = md.split("## How the work is done")[1].split("\n## ")[0];
  assert.ok(!/%|total/i.test(section), section);
  assert.ok(!renderMarkdown(baseProfile()).includes("How the work is done"));
});

test("months counted in the profile zone may exceed the UTC window span by one, not by two", () => {
  const p = (months) => ({
    ...withBlock(block([item({ seen: 5, of: 5, products: 1, months })], { timezone: "Europe/Rome" })),
    window: { from: "2026-01", to: "2026-01" },
    intensity: { timezone: "Europe/Rome" },
  });
  // Rome 2026-01-01T00:30Z is 01:30 on 1 Jan; 2026-01-31T23:30Z is 00:30 on 1 Feb:
  // sessions at both ends sit in a one-month UTC window but fall in 2 Rome months.
  assert.deepEqual(issuesOf(p(2)), []);
  assert.equal(issuesOf(p(3)).length, 1);
});
