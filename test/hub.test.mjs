// The sign-in and the send, with fetch, the browser opener and the clock injected:
// no network, no timers, no real browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHub, signIn, openInBrowser, DEFAULT_HUB, PREVIEW_HUB } from "../src/hub.mjs";
import { submitProfile } from "../src/submit.mjs";

const HUB = "https://hub.test";
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const started = {
  device_code: "dev-code",
  user_code: "ABCD-EFGH",
  verification_uri: `${HUB}/hub/cli`,
  verification_uri_complete: `${HUB}/hub/cli?code=ABCD-EFGH`,
  expires_in: 600,
  interval: 5,
};

// A scripted hub: the device start, then the given token answers in order.
function scriptedHub(tokenAnswers, { intake } = {}) {
  const calls = [];
  const queue = [...tokenAnswers];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === `${HUB}/api/hub/cli/device`) return json(200, started);
    if (url === `${HUB}/api/hub/cli/token`) return queue.shift();
    if (url === `${HUB}/api/hub/work-profiles`) return intake ? intake(init) : json(201, { state: "draft", review_url: `${HUB}/hub/me` });
    throw new Error(`unexpected request ${url}`);
  };
  return { fetchFn, calls };
}

const harness = () => {
  const out = { logs: [], opened: [], sleeps: [] };
  return {
    out,
    opts: {
      log: (m) => out.logs.push(m),
      open: async (u) => { out.opened.push(u); return true; },
      sleep: async (ms) => { out.sleeps.push(ms); },
    },
  };
};

test("resolveHub: default, env, flag, and the preview shorthand", () => {
  assert.equal(resolveHub(undefined, {}), DEFAULT_HUB);
  assert.equal(resolveHub(undefined, { WORK_PROFILE_HUB_URL: "https://env.test/" }), "https://env.test");
  assert.equal(resolveHub("https://flag.test", { WORK_PROFILE_HUB_URL: "https://env.test" }), "https://flag.test");
  assert.equal(resolveHub("preview", {}), PREVIEW_HUB);
  assert.equal(PREVIEW_HUB, "https://preview.letsrebase.com");
});

test("signIn: prints the code, opens the complete uri, polls pending then succeeds", async () => {
  const { fetchFn, calls } = scriptedHub([
    json(400, { error: "authorization_pending" }),
    json(400, { error: "authorization_pending" }),
    json(200, { access_token: "tok", expires_in: 900 }),
  ]);
  const { out, opts } = harness();
  const token = await signIn(HUB, { fetchFn, ...opts });
  assert.equal(token, "tok");
  assert.deepEqual(out.opened, [started.verification_uri_complete]);
  assert.ok(out.logs.some((l) => l.includes("ABCD-EFGH")));
  assert.deepEqual(out.sleeps, [5000, 5000, 5000]);
  const start = calls[0];
  assert.deepEqual(JSON.parse(start.init.body), { scope: "work_profile" });
  assert.deepEqual(JSON.parse(calls[1].init.body), { device_code: "dev-code" });
});

test("signIn: slow_down grows the interval by 5 seconds", async () => {
  const { fetchFn } = scriptedHub([
    json(400, { error: "slow_down" }),
    json(400, { error: "authorization_pending" }),
    json(200, { access_token: "tok" }),
  ]);
  const { out, opts } = harness();
  await signIn(HUB, { fetchFn, ...opts });
  assert.deepEqual(out.sleeps, [5000, 10000, 10000]);
});

test("signIn: prints the address when no browser can be opened", async () => {
  const { fetchFn } = scriptedHub([json(200, { access_token: "tok" })]);
  const { out, opts } = harness();
  await signIn(HUB, { fetchFn, ...opts, open: async () => false });
  assert.ok(out.logs.some((l) => l.includes(started.verification_uri_complete)));
});

test("signIn: access_denied and expired_token are explained, nothing is sent", async () => {
  const denied = scriptedHub([json(400, { error: "access_denied" })]);
  await assert.rejects(signIn(HUB, { fetchFn: denied.fetchFn, ...harness().opts }), /Annulla.*nothing was sent/);
  const expired = scriptedHub([json(400, { error: "expired_token" })]);
  await assert.rejects(signIn(HUB, { fetchFn: expired.fetchFn, ...harness().opts }), /expired.*new code/);
});

test("signIn: a failed start is reported", async () => {
  const fetchFn = async () => json(429, { detail: "too many sign-ins, try later" });
  await assert.rejects(signIn(HUB, { fetchFn, ...harness().opts }), /429.*too many/);
});

test("openInBrowser: picks the platform opener and reports a missing one", async () => {
  const seen = [];
  const fake = (cmd, args) => {
    seen.push([cmd, args]);
    const handlers = {};
    return { once: (e, f) => { handlers[e] = f; if (e === "spawn") queueMicrotask(f); }, unref() {} };
  };
  assert.equal(await openInBrowser("https://x.test/?a=1", { platform: "linux", spawnFn: fake }), true);
  assert.deepEqual(seen[0], ["xdg-open", ["https://x.test/?a=1"]]);
  await openInBrowser("https://x.test/", { platform: "darwin", spawnFn: fake });
  assert.equal(seen[1][0], "open");
  const missing = () => ({ once: (e, f) => { if (e === "error") queueMicrotask(f); }, unref() {} });
  assert.equal(await openInBrowser("https://x.test/", { platform: "linux", spawnFn: missing }), false);
});

const tmpProfile = (profile) => {
  const dir = mkdtempSync(join(tmpdir(), "work-profile-submit-"));
  const path = join(dir, "candidate.json");
  writeFileSync(path, JSON.stringify(profile));
  return path;
};

const base = () => ({
  schema: "playnew-profile/v1",
  contact: { name: "X", email: "x@y.z", city: "C", status: "freelance" },
  volume: { products: 1, sessions: 3, instructions: 9 },
  projects: [{ id: "p1", repoLabel: "acme-storefront", sessions: 3 }],
  otherProjects: [],
});

test("submitProfile: bearer token, one multipart part `profile` named candidate.json, no contact, no repoLabel", async () => {
  const { fetchFn, calls } = scriptedHub([json(200, { access_token: "tok" })]);
  const { opts } = harness();
  const res = await submitProfile(tmpProfile(base()), { hub: HUB, fetchFn, ...opts });
  assert.equal(res.review_url, `${HUB}/hub/me`);
  const post = calls.find((c) => c.url === `${HUB}/api/hub/work-profiles`);
  assert.equal(post.init.method, "POST");
  assert.equal(post.init.headers.authorization, "Bearer tok");
  const parts = [...post.init.body.entries()];
  assert.equal(parts.length, 1);
  const [name, file] = parts[0];
  assert.equal(name, "profile");
  assert.equal(file.name, "candidate.json");
  const sent = JSON.parse(await file.text());
  assert.ok(!("contact" in sent));
  assert.ok(!JSON.stringify(sent).includes("repoLabel"));
});

test("submitProfile: a file artifact is refused before any sign-in", async () => {
  const profile = base();
  profile.projects[0].artifact = { type: "file", path: "/tmp/x.png" };
  const { fetchFn, calls } = scriptedHub([]);
  await assert.rejects(submitProfile(tmpProfile(profile), { hub: HUB, fetchFn, ...harness().opts }), /link/);
  assert.equal(calls.length, 0);
});

test("submitProfile: a 401 from the intake says to sign in anew", async () => {
  const { fetchFn } = scriptedHub([json(200, { access_token: "tok" })], { intake: () => json(401, { detail: "no" }) });
  await assert.rejects(submitProfile(tmpProfile(base()), { hub: HUB, fetchFn, ...harness().opts }), /sign in anew/);
});

test("submitProfile: a refusal of the content is reported with its answer", async () => {
  const { fetchFn } = scriptedHub([json(200, { access_token: "tok" })], { intake: () => json(422, { detail: "groundedness 40" }) });
  await assert.rejects(submitProfile(tmpProfile(base()), { hub: HUB, fetchFn, ...harness().opts }), /422.*groundedness 40/);
});
