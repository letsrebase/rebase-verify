import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startAgent,
  ToolUseError,
  AgentAuthError,
  AgentStartError,
  ModelNotOfferedError,
} from "../src/agents/acp.mjs";
import { AGENT_RUN_MARKER } from "../src/agent-run.mjs";

const FAKE = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
const spec = (env = {}, extra = {}) => ({
  command: process.execPath,
  args: [FAKE],
  env: Object.keys(env),
  systemPromptVia: "inline",
  ...extra,
});
// The fake reads its script from env names listed in spec.env, so set them on this process.
async function withEnv(env, fn) {
  const old = {};
  for (const [k, v] of Object.entries(env)) {
    old[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(old)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}
async function run(env, s, opts, fn) {
  return withEnv(env, async () => {
    const events = [];
    const dir = mkdtempSync(join(tmpdir(), "acp-test-"));
    const logFile = join(dir, "log.jsonl");
    let session;
    try {
      session = await startAgent(s ?? spec(env), { onEvent: (e) => events.push(e), logFile, ...opts });
      return await fn(session, { events, logFile });
    } finally {
      await session?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
const echo = async (env, s, call) => run({ FAKE_ECHO: "1", ...env }, s, {}, async (a) => JSON.parse((await call(a)).text));

test("assembles text from chunks and reports usage", () =>
  run({ FAKE_ANSWER: "hello world, in chunks" }, null, {}, async (a) => {
    const r = await a.prompt("hi", {});
    assert.equal(r.text, "hello world, in chunks");
    assert.equal(r.usage.totalTokens, 7);
  }));

test("lists models and sets one through set_config_option", () =>
  run({ FAKE_MODELS: "m1,m2" }, null, {}, async (a, { events }) => {
    assert.deepEqual(a.models, [
      { id: "m1", name: "Name m1" },
      { id: "m2", name: "Name m2" },
    ]);
    assert.equal(a.currentModel, "m1");
    await a.setModel("m2");
    assert.equal(a.currentModel, "m2");
    assert.ok(events.some((e) => e.kind === "model-set" && e.model === "m2"));
    await assert.rejects(a.setModel("nope"), ModelNotOfferedError);
  }));

test("the chosen model reaches the agent", () =>
  echo({ FAKE_MODELS: "m1,m2" }, null, async (a) => {
    await a.setModel("m2");
    return a.prompt("x", {});
  }).then((o) => assert.equal(o.model, "m2")));

test("no model option: empty list, null, setModel throws", () =>
  run({}, spec({}), {}, async (a) => {
    assert.deepEqual(a.models, []);
    assert.equal(a.currentModel, null);
    await assert.rejects(a.setModel("m1"), ModelNotOfferedError);
  }));

test("mode is set before prompting", async () => {
  const o = await echo({ FAKE_MODES: "agent,read-only" }, spec({ FAKE_ECHO: 1, FAKE_MODES: 1 }, { mode: "read-only" }), (a) =>
    a.prompt("x", {}),
  );
  assert.equal(o.mode, "read-only");
});

test("inline system is prepended; meta and param go to session/new", async () => {
  const inline = await echo({}, spec({ FAKE_ECHO: 1 }, { system: "SYS" }), (a) => a.prompt("USER", { system: "SYS" }));
  assert.equal(inline.promptText, "SYS\n\nUSER");
  const meta = await echo({}, spec({ FAKE_ECHO: 1 }, { systemPromptVia: "meta", system: "SYS", sessionMeta: { claudeCode: { options: { tools: [] } } } }), (a) =>
    a.prompt("USER", { system: "SYS" }),
  );
  assert.equal(meta.promptText, "USER");
  assert.equal(meta.params._meta.systemPrompt, "SYS");
  assert.deepEqual(meta.params._meta.claudeCode.options.tools, []);
  const param = await echo({}, spec({ FAKE_ECHO: 1 }, { systemPromptVia: "param", system: "SYS" }), (a) =>
    a.prompt("USER", { system: "SYS" }),
  );
  assert.equal(param.promptText, "USER");
  assert.deepEqual(param.params.systemPrompt, { mode: "append", content: [{ type: "text", text: "SYS" }] });
});

test("fresh marker cwd, empty, removed on close", async () => {
  let cwd;
  const o = await echo({}, null, async (a) => a.prompt("x", {}));
  cwd = o.cwd;
  assert.ok(basename(cwd).startsWith(AGENT_RUN_MARKER) || cwd.includes(AGENT_RUN_MARKER));
  assert.equal(existsSync(cwd), false);
});

test("env: base allowlist plus named extras only", async () => {
  process.env.SECRET_TOKEN = "s";
  process.env.ANTHROPIC_API_KEY = "k";
  process.env.EXTRA_OK = "1";
  try {
    const o = await echo({}, spec({ FAKE_ECHO: 1, EXTRA_OK: 1, MISSING_ONE: 1 }), (a) => a.prompt("x", {}));
    assert.ok(o.envNames.includes("EXTRA_OK"));
    assert.ok(o.envNames.includes("FAKE_ECHO"));
    assert.ok(!o.envNames.includes("SECRET_TOKEN"));
    assert.ok(!o.envNames.includes("ANTHROPIC_API_KEY"));
    assert.ok(!o.envNames.includes("MISSING_ONE"));
  } finally {
    delete process.env.SECRET_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.EXTRA_OK;
  }
});

test("permission requests are answered with the reject option", () =>
  run({ FAKE_PERM: "1" }, null, {}, async (a) => {
    const r = await a.prompt("x", {});
    assert.deepEqual(JSON.parse(r.text), { perm: { outcome: "selected", optionId: "deny" } });
  }));

test("tool_call trips: cancel, ToolUseError, tool-tripped event", () =>
  run({ FAKE_TOOL: "1" }, null, {}, async (a, { events }) => {
    await assert.rejects(a.prompt("x", {}), (e) => e instanceof ToolUseError && /Run ls/.test(e.message));
    assert.ok(events.some((e) => e.kind === "tool-tripped"));
    assert.ok(events.some((e) => e.kind === "tool_call"));
  }));

test("auth errors map to AgentAuthError at session/new, prompt, and no-model details", async () => {
  await assert.rejects(run({ FAKE_AUTH: "new" }, null, {}, () => {}), AgentAuthError);
  await run({ FAKE_AUTH: "prompt" }, null, {}, (a) => assert.rejects(a.prompt("x", {}), AgentAuthError));
  await run({ FAKE_AUTH: "details" }, null, {}, (a) => assert.rejects(a.prompt("x", {}), AgentAuthError));
});

test("missing command is an AgentStartError", async () => {
  await assert.rejects(
    startAgent({ command: "rebase-verify-no-such-command-xyz", args: [], systemPromptVia: "inline" }, {}),
    AgentStartError,
  );
});

test("cancel ends a hung turn and returns the partial text", () =>
  run({ FAKE_HANG: "1" }, null, {}, async (a, { events }) => {
    const p = a.prompt("x", {});
    await new Promise((resolve) => {
      const t = setInterval(() => events.some((e) => e.kind === "agent_message_chunk") && (clearInterval(t), resolve()), 5);
    });
    await a.cancel();
    const r = await p;
    assert.equal(r.stopReason, "cancelled");
    assert.equal(r.text, "partial");
  }));

test("abort signal: prompt rejects, child gone, dir removed", async () => {
  await withEnv({ FAKE_HANG: "1", FAKE_ECHO: "1" }, async () => {
    const ac = new AbortController();
    const events = [];
    const a = await startAgent(spec({ FAKE_HANG: 1 }), { signal: ac.signal, onEvent: (e) => events.push(e) });
    const started = events.find((e) => e.kind === "started");
    assert.ok(existsSync(started.cwd));
    const p = a.prompt("x", {});
    await new Promise((resolve) => {
      const t = setInterval(() => events.some((e) => e.kind === "agent_message_chunk") && (clearInterval(t), resolve()), 5);
    });
    ac.abort();
    await assert.rejects(p, (e) => e.name === "AbortError");
    assert.equal(existsSync(started.cwd), false);
    assert.throws(() => process.kill(started.pid, 0));
  });
});

test("log file: every message both ways; initialize response redacted", () =>
  run({ FAKE_ANSWER: "logged" }, null, {}, async (a, { logFile }) => {
    await a.prompt("hi", {});
    const lines = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(lines.every((l) => typeof l.t === "number" && (l.dir === "in" || l.dir === "out")));
    assert.ok(lines.some((l) => l.dir === "out" && l.msg?.method === "session/prompt"));
    assert.ok(lines.some((l) => l.dir === "in" && l.msg?.method === "session/update"));
    const red = lines.find((l) => l.redacted);
    assert.equal(red.method, "initialize");
    assert.equal(red.msg, undefined);
    assert.ok(!readFileSync(logFile, "utf8").includes("secret@example.com"));
  }));
