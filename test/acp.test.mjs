import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startAgent,
  ToolUseError,
  AgentAuthError,
  AgentStartError,
  ModelNotOfferedError,
  windowsCommandLine,
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

const gone = async (pid) => {
  for (let i = 0; i < 200; i++) {
    try {
      process.kill(pid, 0);
    } catch (e) {
      if (e.code === "ESRCH") return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};
const markerDirs = () => readdirSync(tmpdir()).filter((n) => n.startsWith(AGENT_RUN_MARKER));

test("tool_call_update for an unseen id trips like a tool_call", () =>
  run({ FAKE_TOOL: "update" }, null, {}, async (a) => {
    await assert.rejects(a.prompt("x", {}), (e) => e instanceof ToolUseError && /Ghost/.test(e.message));
  }));

test("a tool event outside a turn fails the next prompt without sending it", () =>
  run({ FAKE_LATE_TOOL: "1" }, null, {}, async (a, { events, logFile }) => {
    await a.prompt("first", {});
    await new Promise((resolve) => {
      const t = setInterval(() => events.some((e) => e.kind === "tool_call") && (clearInterval(t), resolve()), 5);
    });
    await assert.rejects(a.prompt("second", {}), ToolUseError);
    const sent = readFileSync(logFile, "utf8").split("\n").filter((l) => l.includes('"session/prompt"') && l.includes('"dir":"out"'));
    assert.equal(sent.length, 1);
  }));

test("a trip that the agent ignores ends after the grace period", async () => {
  await withEnv({ FAKE_TOOL: "nocancel" }, async () => {
    const events = [];
    const a = await startAgent({ ...spec({ FAKE_TOOL: 1 }), tripGraceMs: 100 }, { onEvent: (e) => events.push(e) });
    const cwd = events.find((e) => e.kind === "started").cwd;
    await assert.rejects(a.prompt("x", {}), ToolUseError);
    assert.equal(existsSync(cwd), false);
  });
});

test("close kills the whole process group (grandchild)", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-gc-"));
  const pidFile = join(dir, "pid");
  try {
    await withEnv({ FAKE_GRANDCHILD: pidFile }, async () => {
      const a = await startAgent(spec({ FAKE_GRANDCHILD: 1 }), {});
      const gpid = Number(readFileSync(pidFile, "utf8"));
      process.kill(gpid, 0);
      await a.close();
      assert.ok(await gone(gpid), "grandchild still alive");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a child that exits at startup or mid-turn is an AgentStartError with its stderr", async () => {
  await assert.rejects(run({ FAKE_EXIT: "init" }, null, {}, () => {}), (e) => e instanceof AgentStartError && /boom: fake agent died/.test(e.message) && e.message.includes(process.execPath));
  await run({ FAKE_EXIT: "prompt" }, null, {}, (a) =>
    assert.rejects(a.prompt("x", {}), (e) => e instanceof AgentStartError && /died mid-turn/.test(e.message)),
  );
});

test("a setup failure leaves no temp dir", async () => {
  const before = markerDirs().length;
  const dir = mkdtempSync(join(tmpdir(), "acp-blk-"));
  writeFileSync(join(dir, "file"), "x");
  try {
    await assert.rejects(startAgent(spec(), { logFile: join(dir, "file", "sub", "log.jsonl") }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(markerDirs().length, before);
});

test("a different system in prompt() is refused when it is fixed at start", async () => {
  await run({}, spec({}, { systemPromptVia: "meta", system: "SYS" }), {}, async (a) => {
    await assert.rejects(a.prompt("x", { system: "OTHER" }), /fixed when the agent starts/);
    assert.equal((await a.prompt("x", { system: "SYS" })).text, "ok");
    assert.equal((await a.prompt("x", {})).text, "ok");
  });
});

test("sessionParams reach session/new", () =>
  run({}, spec({}, { sessionParams: { extra: 1 } }), {}, async (a, { logFile }) => {
    const out = readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const created = out.find((l) => l.dir === "out" && l.msg?.method === "session/new");
    assert.equal(created.msg.params.extra, 1);
  }));

test("renew opens a fresh session on the same process with the chosen model and the mode re-applied", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-renew-"));
  const turns = join(dir, "turns.jsonl");
  try {
    const env = { FAKE_MODELS: "m1,m2", FAKE_MODES: "ask,read-only", FAKE_TURN_LOG: turns };
    await run(env, spec(env, { mode: "read-only" }), {}, async (a, { logFile, events }) => {
      await a.setModel("m2");
      await a.prompt("one", {});
      await a.renew();
      assert.equal(a.currentModel, "m2");
      await a.prompt("two", {});
      await a.renew();
      await a.prompt("three", {});
      const seen = readFileSync(turns, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.equal(new Set(seen.map((t) => t.sessionId)).size, 3, "a new session each time");
      for (const t of seen) assert.deepEqual([t.model, t.mode], ["m2", "read-only"]);
      const sent = readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.dir === "out").map((l) => l.msg?.method);
      assert.equal(sent.filter((m) => m === "initialize").length, 1, "one connection");
      assert.equal(sent.filter((m) => m === "session/new").length, 3);
      assert.equal(events.filter((e) => e.kind === "started").length, 1, "one process");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a tool call during a turn fails that turn with ToolUseError", () =>
  run({ FAKE_TOOL: "1" }, null, {}, async (a) => {
    await assert.rejects(a.prompt("x", {}), ToolUseError);
  }));

test("renew refuses to start over after a tool event, and keeps refusing", () =>
  run({ FAKE_LATE_TOOL: "1" }, null, {}, async (a, { events, logFile }) => {
    await a.prompt("first", {});
    await new Promise((resolve) => {
      const t = setInterval(() => events.some((e) => e.kind === "tool_call") && (clearInterval(t), resolve()), 5);
    });
    await assert.rejects(a.renew(), ToolUseError);
    await assert.rejects(a.renew(), ToolUseError);
    const created = readFileSync(logFile, "utf8").split("\n").filter((l) => l.includes('"session/new"') && l.includes('"dir":"out"'));
    assert.equal(created.length, 1, "no new session was opened");
  }));

test("text from a session that is not the current one is dropped", () =>
  run({ FAKE_STRAY: "text", FAKE_ANSWER: "real" }, null, {}, async (a) => {
    assert.equal((await a.prompt("x", {})).text, "real");
    await a.renew();
    assert.equal((await a.prompt("y", {})).text, "real");
  }));

test("a tool call from any session trips, in a turn and outside one", async () => {
  await run({ FAKE_STRAY: "tool" }, null, {}, async (a) => {
    await assert.rejects(a.prompt("x", {}), (e) => e instanceof ToolUseError && /Stray tool/.test(e.message));
  });
  // an old session that was not closed emits a tool_call after renew(): the next prompt refuses
  await run({ FAKE_OLD_TOOL: "1" }, null, {}, async (a, { logFile }) => {
    assert.equal((await a.prompt("x", {})).text, "ok");
    await a.renew();
    await assert.rejects(a.prompt("y", {}), (e) => e instanceof ToolUseError && /Old tool/.test(e.message));
    const sent = readFileSync(logFile, "utf8").split("\n").filter((l) => l.includes('"session/prompt"') && l.includes('"dir":"out"'));
    assert.equal(sent.length, 1, "the second prompt was never sent");
  });
});

test("a spec mode is set after every session/new, as a config option or with set_mode", async () => {
  const afterNew = (logFile) => {
    const out = readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.dir === "out" && l.msg?.method);
    const groups = [];
    for (const { msg } of out) {
      if (msg.method === "session/new") groups.push([]);
      else if (groups.length && msg.method !== "session/prompt") groups.at(-1).push([msg.method, msg.params?.configId ?? null, msg.params?.value ?? msg.params?.modeId ?? null]);
    }
    return groups;
  };
  // the agent offers a mode option
  const withOption = { FAKE_MODES: "ask,read-only" };
  await run(withOption, spec(withOption, { mode: "read-only" }), {}, async (a, { logFile }) => {
    await a.renew();
    assert.deepEqual(afterNew(logFile), [[["session/set_config_option", "mode", "read-only"]], [["session/set_config_option", "mode", "read-only"]]]);
  });
  // the agent offers none: session/set_mode
  await run({}, spec({}, { mode: "read-only" }), {}, async (a, { logFile }) => {
    await a.renew();
    assert.deepEqual(afterNew(logFile), [[["session/set_mode", null, "read-only"]], [["session/set_mode", null, "read-only"]]]);
  });
});

test("renew closes the previous session first when the agent advertises it, and survives a failing close", async () => {
  const sentMethods = (logFile) =>
    readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.dir === "out" && l.msg?.method).map((l) => [l.msg.method, l.msg.params?.sessionId]);
  for (const close of ["1", "error"]) {
    await run({ FAKE_CLOSE: close }, null, {}, async (a, { logFile }) => {
      await a.renew();
      assert.deepEqual(sentMethods(logFile).filter(([m]) => m.startsWith("session/") && m !== "session/set_config_option").map(([m, id]) => `${m}${id ? `:${id}` : ""}`), ["session/new", "session/close:s1", "session/new"]);
      assert.equal((await a.prompt("x", {})).text, "ok");
    });
  }
  await run({}, null, {}, async (a, { logFile }) => {
    await a.renew();
    assert.ok(!sentMethods(logFile).some(([m]) => m === "session/close"), "not advertised, not sent");
  });
});

test("windowsCommandLine quotes args as one string", () =>
  assert.equal(windowsCommandLine("npx", ["-y", "pkg@1", "a b", 'q"x']), 'npx -y pkg@1 "a b" "q""x"'));
