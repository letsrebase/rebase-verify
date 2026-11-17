// Per-technology usage: counts, deterministic bands, tz bucketing, the submit
// re-derivation and the groundedness support of the new numbers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTechUsage, bandFor } from "../src/tech-usage.mjs";
import { buildDigest, labelVocabulary } from "../src/digest.mjs";
import { assessStructure, assessAgainstLogs } from "../src/consistency.mjs";
import { assessGroundedness } from "../src/groundedness.mjs";
import { assembleProfile, renderMarkdown } from "../src/profile.mjs";
import { sess } from "./factories.mjs";

const months = (from, n) => Array.from({ length: n }, (_, i) => {
  const t = (+from.slice(0, 4)) * 12 + (+from.slice(5) - 1) + i;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
});
const proj = (tech, sessions, ms) => ({ tech, sessions, months: ms });

test("counts sessions, products and distinct months per technology across all products", () => {
  const u = computeTechUsage([
    proj(["Supabase", "React"], 10, ["2026-01", "2026-02"]),
    proj(["Supabase"], 4, ["2026-02", "2026-04"]),
    proj([], 3, ["2026-05"]),
  ]);
  const s = u.technologies.find((t) => t.name === "Supabase");
  assert.deepEqual(s, { name: "Supabase", sessions: 14, products: 2, months: 3, firstMonth: "2026-01", lastMonth: "2026-04", band: "recurring" });
  assert.equal(u.technologies.find((t) => t.name === "React").sessions, 10);
  assert.equal(u.timezone, "UTC");
  assert.deepEqual(u.technologies.map((t) => t.name), ["Supabase", "React"]); // sessions desc
});

test("returns null when no technology was detected", () => {
  assert.equal(computeTechUsage([proj([], 3, ["2026-05"])]), null);
  assert.equal(computeTechUsage([]), null);
  assert.equal(computeTechUsage(null), null);
});

test("band thresholds: occasional < 3 months <= recurring; continuous needs 6 months AND 75% coverage", () => {
  const b = (n, from, last) => bandFor({ months: n, firstMonth: from, lastMonth: last });
  assert.equal(b(1, "2026-01", "2026-01"), "occasional");
  assert.equal(b(2, "2026-01", "2026-09"), "occasional");
  assert.equal(b(3, "2026-01", "2026-12"), "recurring");
  assert.equal(b(5, "2026-01", "2026-05"), "recurring"); // full coverage but under 6 months
  assert.equal(b(6, "2026-01", "2026-06"), "continuous");
  assert.equal(b(9, "2026-01", "2026-12"), "continuous"); // 9/12 = 75%
  assert.equal(b(8, "2026-01", "2026-12"), "recurring"); // 8/12 < 75%
  assert.equal(b(6, "2025-11", "2026-04"), "continuous"); // spans a year boundary: 6/6
});

test("a technology seen only in months-less products is not reported", () => {
  assert.equal(computeTechUsage([proj(["React"], 5, [])]), null);
});

test("digest buckets months in the requested timezone, like days", () => {
  // 2026-03-31T23:30Z is already April in Rome (UTC+2 in summer time).
  const parsed = { source: "claude-code", sessions: [sess("claude-code", "acme-app", [], { ts: "2026-03-31T23:30:00.000Z" })] };
  assert.deepEqual(buildDigest(parsed).projects[0].months, ["2026-03"]);
  assert.deepEqual(buildDigest(parsed, { tz: "Europe/Rome" }).projects[0].months, ["2026-04"]);
});

test("every name that can appear comes from the detector's fixed vocabulary", () => {
  const vocab = new Set(labelVocabulary());
  const u = computeTechUsage([proj([...vocab], 2, ["2026-01"])]);
  for (const t of u.technologies) assert.ok(vocab.has(t.name));
});

// --- profile wiring ----------------------------------------------------------

const usage = () => ({
  timezone: "UTC",
  technologies: [
    { name: "Supabase", sessions: 14, products: 2, months: 7, firstMonth: "2026-01", lastMonth: "2026-08", band: "continuous" },
    { name: "React", sessions: 6, products: 1, months: 2, firstMonth: "2026-02", lastMonth: "2026-03", band: "occasional" },
  ],
});
const baseProj = { repo: "acme-app", cwdRaw: "", type: ["feature-work"], from: "2026-01", to: "2026-08", sessions: 14, userMessages: 30, tech: ["Supabase"], landing: { commits: 1, reverts: 0, revertChurn: "low", checksRun: false }, selected: true };

test("assembleProfile carries techUsage and defaults it to null (old shape unchanged)", () => {
  const args = { contact: { name: "X" }, projects: [baseProj], narrative: null, fingerprint: null, forensics: null };
  assert.equal(assembleProfile(args).techUsage, null);
  assert.deepEqual(assembleProfile({ ...args, techUsage: usage() }).techUsage, usage());
});

test("profile.md renders the block deterministically, with the zone when not UTC", () => {
  const profile = { ...assembleProfile({ contact: { name: "X" }, projects: [baseProj], narrative: null, fingerprint: null, forensics: null, techUsage: usage() }) };
  const md = renderMarkdown(profile);
  assert.ok(md.includes("## Technology usage"));
  assert.ok(md.includes("- Supabase: continuous · 14 sessions · 2 products · 7 months (2026-01 to 2026-08)"), md);
  assert.ok(md.includes("- React: occasional · 6 sessions · 1 product · 2 months (2026-02 to 2026-03)"), md);
  profile.techUsage.timezone = "Europe/Rome";
  assert.ok(renderMarkdown(profile).includes("months counted in Europe/Rome"));
  profile.techUsage = null;
  assert.ok(!renderMarkdown(profile).includes("Technology usage"));
});

const prof = () => ({
  volume: { products: 3, sessions: 20, instructions: 10 },
  projects: [], otherProjects: [],
  techUsage: usage(),
});

test("structure: an honest block passes; a band that does not match its counts is caught", () => {
  assert.deepEqual(assessStructure(prof()).issues.filter((i) => i.startsWith("techUsage")), []);
  const p = prof();
  p.techUsage.technologies[1].band = "continuous";
  assert.ok(assessStructure(p).issues.some((i) => i.includes("techUsage.React") && i.includes("band")));
});

test("structure: impossible counts are caught", () => {
  const p = prof();
  p.techUsage.technologies[0].months = 40; // cannot fit in 2026-01..2026-08
  p.techUsage.technologies[1].sessions = 99; // more than the profile has
  const issues = assessStructure(p).issues.join("\n");
  assert.ok(issues.includes("cannot fit"), issues);
  assert.ok(issues.includes("99 sessions"), issues);
});

test("logs: claims at or below the re-derivation pass; inflated ones are excess claims", () => {
  const derived = usage();
  assert.deepEqual(assessAgainstLogs(prof(), [], { techUsage: derived }).issues.filter((i) => i.startsWith("techUsage")), []);

  const p = prof();
  p.techUsage.technologies[0].months = 8;
  p.techUsage.technologies[0].sessions = 20;
  p.techUsage.technologies[1].firstMonth = "2025-12";
  p.techUsage.technologies[1].lastMonth = "2026-05";
  const r = assessAgainstLogs(p, [], { techUsage: derived });
  const t = r.issues.filter((i) => i.startsWith("techUsage")).join("\n");
  assert.ok(t.includes("claims 8 months"), t);
  assert.ok(t.includes("claims 20 sessions"), t);
  assert.ok(t.includes("first month 2025-12"), t);
  assert.ok(t.includes("last month 2026-05"), t);
  assert.equal(r.issues.filter((i) => i.startsWith("techUsage")).length, 4);
});

test("logs: a technology the logs do not re-derive is an excess claim; a smaller re-derivation (pruned logs) flags the surplus", () => {
  const p = prof();
  const derived = { timezone: "UTC", technologies: [{ name: "Supabase", sessions: 9, products: 2, months: 7, firstMonth: "2026-01", lastMonth: "2026-08", band: "continuous" }] };
  const r = assessAgainstLogs(p, [], { techUsage: derived });
  const t = r.issues.join("\n");
  assert.ok(t.includes("techUsage.React: claimed but the logs re-derive no such technology"), t);
  assert.ok(t.includes("claims 14 sessions, logs re-derive 9"), t);
});

test("logs: no check without a claimed block, or without a re-derivation", () => {
  assert.deepEqual(assessAgainstLogs({ volume: {} }, [], { techUsage: usage() }).issues, []);
  assert.deepEqual(assessAgainstLogs(prof(), []).issues.filter((i) => i.startsWith("techUsage")), []);
});

test("groundedness: the new counts and months support prose that cites them, and nothing else", () => {
  const p = prof();
  p.projects = [];
  p.summary = "Used Supabase across 7 months, in 14 sessions and 2 products.";
  const ok = assessGroundedness(p);
  assert.equal(ok.anomalies.length, 0, JSON.stringify(ok.anomalies));
  assert.ok(ok.total >= 4);
  // First and last months join the period pool.
  const per = assessGroundedness({ ...p, summary: "Active since 2026-01 and until 2026-08." });
  assert.ok(!per.anomalies.some((a) => a.kind === "period"), JSON.stringify(per.anomalies));

  const bad = { ...p, summary: "Used Supabase across 31 months in 477 sessions." };
  const g = assessGroundedness(bad);
  assert.ok(g.anomalies.some((a) => a.anchor === "477"), JSON.stringify(g.anomalies));
  assert.ok(g.anomalies.some((a) => a.anchor === "31"), JSON.stringify(g.anomalies));
});

test("groundedness: a technology only in techUsage still grounds its name", () => {
  const p = { ...prof(), projects: [], summary: "Worked with React for 2 months, 6 sessions, 14 sessions overall." };
  const g = assessGroundedness(p);
  assert.ok(!g.anomalies.some((a) => a.kind === "tech"), JSON.stringify(g.anomalies));
  const without = { ...p, techUsage: null };
  assert.ok(assessGroundedness(without).anomalies.some((a) => a.anchor.toLowerCase() === "react"));
});
