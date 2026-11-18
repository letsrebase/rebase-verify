// The sign-in and the send, with fetch, the browser opener and the clock injected:
// no network, no timers, no real browser.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  assert.equal(resolveHub(undefined, { REBASE_VERIFY_HUB_URL: "https://env.test/" }), "https://env.test");
  assert.equal(resolveHub("https://flag.test", { REBASE_VERIFY_HUB_URL: "https://env.test" }), "https://flag.test");
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

const tmpDirs = [];
after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

const tmpProfile = (profile) => {
  const dir = mkdtempSync(join(tmpdir(), "rebase-verify-submit-"));
  tmpDirs.push(dir);
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

// --- review follow-ups ----------------------------------------------------------

import { safeBrowserUrl } from "../src/hub.mjs";

test("openInBrowser on win32 never goes through cmd", async () => {
  const seen = [];
  const fake = (cmd, args) => {
    seen.push([cmd, args]);
    return { once: (e, f) => { if (e === "spawn") queueMicrotask(f); }, unref() {} };
  };
  await openInBrowser(`${HUB}/hub/cli?code=A`, { platform: "win32", spawnFn: fake });
  assert.equal(seen[0][0], "rundll32");
  assert.deepEqual(seen[0][1], ["url.dll,FileProtocolHandler", `${HUB}/hub/cli?code=A`]);
  assert.notEqual(seen[0][0], "cmd");
});

test("safeBrowserUrl refuses shell metacharacters, other origins and plain http", () => {
  assert.equal(safeBrowserUrl(`${HUB}/hub/cli?code=A-B`, HUB), `${HUB}/hub/cli?code=A-B`);
  for (const bad of [`${HUB}/a|calc`, `${HUB}/a"b`, `${HUB}/a^b`, `${HUB}/a<b`, "https://evil.test/hub/cli", "http://hub.test/hub/cli", "javascript:alert(1)", "not a url"]) {
    assert.equal(safeBrowserUrl(bad, HUB), null, bad);
  }
  assert.equal(safeBrowserUrl("http://localhost:8000/hub/cli", "http://localhost:8000"), "http://localhost:8000/hub/cli");
});

test("signIn prints, and does not open, a link that fails the checks", async () => {
  const fetchFn = async (url) => url.endsWith("/device")
    ? json(200, { ...started, verification_uri_complete: "https://evil.test/x" })
    : json(200, { access_token: "tok" });
  const { out, opts } = harness();
  await signIn(HUB, { fetchFn, ...opts });
  assert.deepEqual(out.opened, []);
  assert.ok(out.logs.some((l) => l.includes("https://evil.test/x")));
});

test("signIn keeps polling through a network error, a 5xx and a non-JSON answer, backing off", async () => {
  const answers = [
    () => { throw new Error("ECONNRESET"); },
    () => json(503, { error: "x" }),
    () => new Response("<html>bad gateway</html>", { status: 200 }),
    () => json(200, { access_token: "tok" }),
  ];
  const fetchFn = async (url) => (url.endsWith("/device") ? json(200, started) : answers.shift()());
  const { out, opts } = harness();
  assert.equal(await signIn(HUB, { fetchFn, ...opts }), "tok");
  assert.deepEqual(out.sleeps, [5000, 10000, 15000, 20000]);
});

test("signIn gives up locally once the deadline has passed", async () => {
  let t = 0;
  const fetchFn = async (url) => (url.endsWith("/device") ? json(200, { ...started, expires_in: 60 }) : json(400, { error: "authorization_pending" }));
  const { opts } = harness();
  await assert.rejects(
    signIn(HUB, { fetchFn, ...opts, now: () => t, sleep: async (ms) => { t += ms; } }),
    /took too long/,
  );
});

test("the token never appears in anything printed", async () => {
  const { fetchFn } = scriptedHub([json(200, { access_token: "SECRET-TOKEN" })]);
  const { out, opts } = harness();
  await submitProfile(tmpProfile(base()), { hub: HUB, fetchFn, ...opts });
  assert.ok(!out.logs.join("\n").includes("SECRET-TOKEN"));
});

test("submitProfile: a thrown fetch on the intake says to run submit again and sign in anew", async () => {
  const { fetchFn } = scriptedHub([json(200, { access_token: "tok" })], { intake: () => { throw new Error("socket hang up"); } });
  await assert.rejects(submitProfile(tmpProfile(base()), { hub: HUB, fetchFn, ...harness().opts }), /run submit again and sign in anew/);
});

test("every request carries User-Agent rebase-verify/<package version>", async () => {
  const { version } = JSON.parse((await import("node:fs")).readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const { fetchFn, calls } = scriptedHub([json(200, { access_token: "tok" })]);
  await submitProfile(tmpProfile(base()), { hub: HUB, fetchFn, ...harness().opts });
  assert.equal(calls.length, 3);
  for (const c of calls) assert.equal(c.init.headers["user-agent"], `rebase-verify/${version}`, c.url);
});
