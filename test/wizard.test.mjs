// The wizard's decisions, driven without a TTY and without agents: the clack
// functions and every reader, agent and writer are injected.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { runWizard, consentText, statusLine, rejectedFlags } from "../src/wizard.mjs";
import { liveStatus } from "../src/live-status.mjs";
import { AgentAuthError } from "../src/agents/acp.mjs";

const CANCEL = Symbol("cancel");
const BIN = fileURLToPath(new URL("../bin/rebase-verify.mjs", import.meta.url));

const CLEANED = [];
const agentEntry = (id, over = {}) => ({ cleanup: (d) => (CLEANED.push(d), []), id, label: id.toUpperCase(), kind: "acp", tested: id !== "kimi", sessions: 0, loginHint: "log in", installHint: `install ${id}`, spec: () => ({ command: id }), ...over });

// answers: queue per prompt kind; a CANCEL entry cancels that prompt.
function fakeUi(answers = {}) {
  const calls = [];
  CLEANED.length = 0;
  const queue = Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, [...v]]));
  const take = (kind, dflt) => {
    const q = queue[kind];
    return q && q.length ? q.shift() : dflt;
  };
  const spin = () => ({
    start: (m) => calls.push(["spinner.start", m]),
    stop: (m) => calls.push(["spinner.stop", m]),
    error: (m) => calls.push(["spinner.error", m]),
    message: (m) => calls.push(["spinner.message", m]),
  });
  return {
    calls,
    isCancel: (v) => v === CANCEL,
    intro: (m) => calls.push(["intro", m]),
    outro: (m) => calls.push(["outro", m]),
    cancel: (m) => calls.push(["cancel", m]),
    note: (m, t) => calls.push(["note", m, t]),
    log: { info: (m) => calls.push(["log.info", m]), error: (m) => calls.push(["log.error", m]), warn: (m) => calls.push(["log.warn", m]) },
    spinner: spin,
    live: (o) => ({ ...spin(), onCancel: o.onCancel }),
    multiselect: async (o) => (calls.push(["multiselect", o]), take("multiselect", o.initialValues)),
    select: async (o) => (calls.push(["select", o]), take("select", o.initialValue ?? o.options[0].value)),
    confirm: async (o) => (calls.push(["confirm", o]), take("confirm", true)),
  };
}

const bundle = (source, n) => ({ source, files: [], sessions: Array.from({ length: n }, () => ({ source })), compactionSummaries: [], redaction: { hits: 0, charsRemoved: 0 } });

function fakeDeps(over = {}) {
  const state = { closed: 0, started: [], ran: [], finished: [], submitted: 0, prepared: [] };
  const session = { models: [{ id: "m1", name: "Model one" }, { id: "m2", name: "Model two" }], currentModel: "m2", close: async () => void state.closed++ };
  const deps = {
    sources: [{ id: "claude-code", label: "Claude Code" }, { id: "omp", label: "oh-my-pi" }, { id: "codex", label: "Codex" }],
    readSource: (id) => bundle(id, { "claude-code": 10, omp: 30, codex: 0 }[id]),
    combine: (bundles) => ({ bundles, sessions: bundles.flatMap((b) => b.sessions) }),
    availableAgents: (by) => [agentEntry("omp", { sessions: by.omp ?? 0 }), agentEntry("claude-code", { sessions: by["claude-code"] ?? 0 }), agentEntry("kimi")],
    defaultAgent: (l) => l[0],
    prepare: (parsed) => (state.prepared.push(parsed), { narrativeInput: { n: 1 }, practicesInput: { p: 1 } }),
    startAgent: async (spec, opts) => {
      state.started.push({ spec, opts });
      opts.onEvent?.({ kind: "started", cwd: "/tmp/rebase-verify-agent-run-x", pid: 4242 });
      return session;
    },
    runWithAgent: async (args) => {
      state.ran.push(args);
      args.onStatus({ step: "narrative" });
      return { narrative: {}, practicesAnswers: null, used: { agent: args.agent.id, model: args.model ?? null } };
    },
    finish: (prepared, run) => (state.finished.push(run), { sessions: 40, products: 3, practices: [{ id: "checks_before_commit", seen: 4, of: 9 }], file: "out/profile.md" }),
    submit: async () => void state.submitted++,
    ...over,
  };
  return { deps, state, session };
}

const run = (ui, deps, extra = {}) => runWizard({ ui, deps, flags: { version: "1.2.3", ...extra }, out: "out", proc: new EventEmitter(), now: () => 0 });
const kinds = (ui, k) => ui.calls.filter((c) => c[0] === k);

test("accepting every default picks the default agent and the current model, sends nothing", async () => {
  const ui = fakeUi();
  const { deps, state } = fakeDeps();
  const code = await run(ui, deps);
  assert.equal(code, 0);
  const [multi] = kinds(ui, "multiselect");
  assert.deepEqual(multi[1].options.map((o) => o.value), ["claude-code", "omp"], "sources without sessions are not offered");
  assert.deepEqual(multi[1].initialValues, ["claude-code", "omp"]);
  const [agentSel, modelSel, submitSel] = kinds(ui, "select");
  assert.equal(agentSel[1].initialValue, "omp");
  assert.match(agentSel[1].options[0].hint, /30 sessions in your logs · tested/);
  assert.match(agentSel[1].options[2].hint, /not tested/);
  assert.equal(modelSel[1].initialValue, "m2");
  assert.equal(state.ran.length, 1);
  assert.equal(state.ran[0].model, "m2");
  assert.equal(state.ran[0].session.currentModel, "m2");
  assert.equal(state.started.length, 1, "the agent is started once and its session reused");
  assert.equal(state.ran[0].runDir, "/tmp/rebase-verify-agent-run-x");
  assert.equal(state.submitted, 0, "the default of the last select is to exit");
  assert.deepEqual(submitSel[1].options.map((o) => o.value), ["submit", "exit"]);
});

test("the profile is built only from the chosen sources", async () => {
  const ui = fakeUi({ multiselect: [["omp"]] });
  const { deps, state } = fakeDeps();
  await run(ui, deps);
  assert.deepEqual(state.prepared[0].bundles.map((b) => b.source), ["omp"]);
  const agentSel = kinds(ui, "select")[0];
  assert.match(agentSel[1].options[1].hint, /10 sessions|0 sessions/);
});

test("choosing 'Send it to rebase now' runs the submit flow", async () => {
  const ui = fakeUi({ select: [undefined, undefined, "submit"].map((v) => v) });
  const { deps, state } = fakeDeps();
  // an undefined answer falls back to the prompt's default
  const orig = ui.select;
  ui.select = async (o) => {
    const v = await orig(o);
    return v === undefined ? o.initialValue ?? o.options[0].value : v;
  };
  assert.equal(await run(ui, deps), 0);
  assert.equal(state.submitted, 1);
});

for (const [name, answers, closes] of [
  ["the source list", { multiselect: [CANCEL] }, 0],
  ["the agent select", { select: [CANCEL] }, 0],
  ["the model select", { select: [undefined, CANCEL] }, 1],
  ["the consent", { confirm: [CANCEL] }, 1],
  ["the final select", { select: [undefined, undefined, CANCEL] }, 0],
]) {
  test(`Ctrl-C at ${name} exits 130 and closes the session it started`, async () => {
    const ui = fakeUi(answers);
    const { deps, state } = fakeDeps();
    const orig = ui.select;
    ui.select = async (o) => {
      const v = await orig(o);
      return v === undefined ? o.initialValue ?? o.options[0].value : v;
    };
    assert.equal(await run(ui, deps), 130);
    assert.deepEqual(kinds(ui, "cancel").at(-1), ["cancel", "Stopped. Nothing was sent."]);
    if (name === "the final select") assert.equal(state.finished.length, 1, "the profile was already written");
    else assert.equal(state.finished.length, 0);
    assert.equal(state.closed, closes);
  });
}

test("declining at the consent closes the session and writes nothing", async () => {
  const ui = fakeUi({ confirm: [false] });
  const { deps, state } = fakeDeps();
  assert.equal(await run(ui, deps), 0);
  assert.equal(state.closed, 1);
  assert.equal(state.ran.length, 0);
  assert.equal(state.finished.length, 0);
  assert.equal(state.submitted, 0);
  assert.match(kinds(ui, "cancel").at(-1)[1], /Nothing was written or sent/);
});

test("no agent installed and no API key: a note with the two ways, exit 1, nothing written", async () => {
  const ui = fakeUi();
  const { deps, state } = fakeDeps({ availableAgents: () => [] });
  assert.equal(await run(ui, deps), 1);
  const note = kinds(ui, "note").at(-1);
  assert.match(note[1], /slash command/);
  assert.match(note[1], /omp/);
  assert.equal(state.finished.length, 0);
  assert.equal(state.started.length, 0);
});

test("an agent that offers no model skips the model select", async () => {
  const ui = fakeUi();
  const { deps, state, session } = fakeDeps();
  session.models = [];
  session.currentModel = null;
  assert.equal(await run(ui, deps), 0);
  assert.equal(kinds(ui, "select").length, 2, "agent and final select only");
  assert.equal(state.ran[0].model, undefined);
  assert.ok(ui.calls.some((c) => c[0] === "log.info" && /default model/.test(c[1])));
});

test("the consent text follows what each agent can promise", () => {
  const omp = consentText(agentEntry("omp"));
  assert.match(omp, /out\/agent-log\.jsonl/);
  assert.match(omp, /switched off/);
  assert.match(omp, /transcript/);
  assert.match(omp, /rebase receives nothing/i);
  assert.match(omp, /60 sessions/);
  const claude = consentText(agentEntry("claude-code"));
  assert.match(claude, /switched off/);
  assert.doesNotMatch(claude, /transcript/);
  const codex = consentText(agentEntry("codex"));
  assert.match(codex, /read-only/);
  assert.match(codex, /transcript/);
  const other = consentText(agentEntry("kimi"));
  assert.match(other, /not known/);
  assert.match(other, /stops if it tries/);
  for (const t of [omp, claude, codex, other]) assert.doesNotMatch(t, /cannot read|can't read|no access to (your )?files/i);
});

test("the status line shows the phase, characters, batches and usage", () => {
  assert.equal(statusLine({ step: "narrative" }, { chars: 1234 }), "Writing the narrative · 1.2k chars");
  assert.equal(statusLine({ step: "narrative" }, { chars: 80 }), "Writing the narrative · 80 chars");
  assert.equal(statusLine({ step: "practices", batch: 2, total: 6 }, { chars: 0, tokens: 3400 }), "Classifying practices · batch 2 of 6 · 3.4k tokens");
  assert.equal(statusLine({ step: "practices", batch: 2, total: 6 }, { chars: 0, cost: { amount: 0.0213, currency: "USD" } }), "Classifying practices · batch 2 of 6 · $0.02");
});

test("live status redraws at most every 100 ms", async () => {
  const ui = fakeUi();
  const { deps } = fakeDeps();
  const seen = {};
  let t = 0;
  const start = deps.startAgent;
  deps.startAgent = async (spec, opts) => ((seen.onEvent = opts.onEvent), start(spec, opts));
  deps.runWithAgent = async (args) => {
    args.onStatus({ step: "narrative" });
    for (let i = 0; i < 5; i++) seen.onEvent({ kind: "agent_message_chunk", content: { type: "text", text: "x".repeat(100) } });
    t = 150;
    seen.onEvent({ kind: "agent_message_chunk", content: { type: "text", text: "y" } });
    return { narrative: {}, practicesAnswers: null, used: { agent: "omp", model: null } };
  };
  await runWizard({ ui, deps, flags: { version: "1" }, out: "out", proc: new EventEmitter(), now: () => t });
  const msgs = kinds(ui, "spinner.message").map((c) => c[1]);
  assert.equal(msgs.length, 2, `got: ${msgs}`);
  assert.match(msgs.at(-1), /501 chars/);
});

test("an agent that is not logged in ends with its login hint and exit 2", async () => {
  const ui = fakeUi();
  const { deps, state } = fakeDeps({
    runWithAgent: async () => {
      throw new AgentAuthError("no");
    },
  });
  assert.equal(await run(ui, deps), 2);
  assert.ok(ui.calls.some((c) => c[0] === "log.error" && /log in/.test(c[1])));
  assert.equal(state.finished.length, 0);
});

test("Ctrl-C during the run aborts the agent and exits 130", async () => {
  const ui = fakeUi();
  const proc = new EventEmitter();
  const { deps, state } = fakeDeps({
    runWithAgent: async (args) => {
      proc.emit("SIGINT");
      assert.equal(args.signal.aborted, true);
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    },
  });
  const code = await runWizard({ ui, deps, flags: { version: "1" }, out: "out", proc, now: () => 0 });
  assert.equal(code, 130);
  assert.equal(proc.listenerCount("SIGINT"), 0);
  assert.equal(state.finished.length, 0);
});

test("--agent and --model skip their selects", async () => {
  const ui = fakeUi();
  const { deps, state } = fakeDeps();
  assert.equal(await run(ui, deps, { agent: "claude-code", model: "m1" }), 0);
  assert.equal(kinds(ui, "select").length, 1, "only the final select");
  assert.equal(state.ran[0].agent.id, "claude-code");
  assert.equal(state.ran[0].model, "m1");
});

test("the bin never starts the wizard without a TTY", () => {
  const home = mkdtempSync(join(tmpdir(), "rv-wiz-"));
  const cwd = mkdtempSync(join(tmpdir(), "rv-wiz-cwd-"));
  try {
    const r = spawnSync(process.execPath, [BIN, "--root", join(home, "none")], {
      cwd, env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: ["pipe", "pipe", "pipe"], encoding: "utf8", input: "", timeout: 60000,
    });
    assert.match(r.stderr, /No logs at/, "it behaves as generate");
    assert.doesNotMatch(r.stdout + r.stderr, /rebase-verify \d/);
    assert.equal(existsSync(join(cwd, "out", "profile.md")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the live status maps Ctrl-C to onCancel and restores the terminal", () => {
  const handlers = [];
  const writes = [];
  const raw = [];
  const input = {
    isTTY: true, isRaw: false, isPaused: () => true,
    setRawMode: (v) => raw.push(v), resume() {}, pause() { raw.push("pause"); },
    on: (ev, fn) => handlers.push([ev, fn]), off: (ev, fn) => { const i = handlers.findIndex(([e, f]) => e === ev && f === fn); if (i >= 0) handlers.splice(i, 1); },
  };
  let cancelled = 0;
  const live = liveStatus({ onCancel: () => cancelled++, input, output: { write: (t) => writes.push(t) }, style: (_c, t) => t, delay: 1e6 });
  live.start("Starting");
  assert.deepEqual(raw, [true]);
  assert.equal(handlers.length, 1);
  handlers[0][1](Buffer.from("a"));
  assert.equal(cancelled, 0);
  handlers[0][1](Buffer.from("\x03"));
  assert.equal(cancelled, 1);
  live.message("Writing");
  live.stop("Done");
  assert.deepEqual(raw, [true, false, "pause"], "raw mode restored, stdin paused again");
  assert.equal(handlers.length, 0);
  assert.match(writes.join(""), /◇  Done/);
  live.stop("again");
  assert.equal(writes.join("").match(/Done/g).length, 1, "stop is idempotent");
});

test("Ctrl-C on the live status during the run aborts it and exits 130 with cleanup", async () => {
  const ui = fakeUi();
  const { deps, state } = fakeDeps({
    runWithAgent: async (args) => {
      ui.calls.find((c) => c[0] === "spinner.start" && /run with/.test(c[1]));
      lastLive.onCancel();
      assert.equal(args.signal.aborted, true);
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    },
  });
  let lastLive;
  const mk = ui.live;
  ui.live = (o) => (lastLive = mk(o));
  assert.equal(await run(ui, deps), 130);
  assert.equal(state.finished.length, 0);
});

test("the exit net kills the agent group and removes the run dir and transcript", async () => {
  const ui = fakeUi();
  const proc = new EventEmitter();
  const killed = [];
  const removed = [];
  const { deps } = fakeDeps({
    killGroup: (pid) => killed.push(pid),
    removeDir: (d) => removed.push(d),
    runWithAgent: async () => {
      proc.emit("exit");
      return { narrative: {}, practicesAnswers: null, used: { agent: "omp", model: null } };
    },
  });
  await runWizard({ ui, deps, flags: { version: "1" }, out: "out", proc, now: () => 0 });
  assert.deepEqual(killed, [4242]);
  assert.deepEqual(removed, ["/tmp/rebase-verify-agent-run-x"]);
  assert.deepEqual(CLEANED, ["/tmp/rebase-verify-agent-run-x"]);
  assert.equal(proc.exitCode, 130);
  assert.equal(proc.listenerCount("exit"), 0);
});

test("no exit handler is left once the run is over", async () => {
  const ui = fakeUi();
  const proc = new EventEmitter();
  const { deps } = fakeDeps();
  await runWizard({ ui, deps, flags: { version: "1" }, out: "out", proc, now: () => 0 });
  assert.equal(proc.listenerCount("exit"), 0);
  assert.equal(proc.exitCode, undefined);
});

for (const [name, answers] of [
  ["a cancelled model select", { select: [undefined, CANCEL] }],
  ["a declined consent", { confirm: [false] }],
  ["a cancelled consent", { confirm: [CANCEL] }],
]) {
  test(`${name} removes the transcript after closing the session`, async () => {
    const ui = fakeUi(answers);
    const { deps, state } = fakeDeps();
    const orig = ui.select;
    ui.select = async (o) => {
      const v = await orig(o);
      return v === undefined ? o.initialValue ?? o.options[0].value : v;
    };
    await run(ui, deps);
    assert.equal(state.closed, 1);
    assert.deepEqual(CLEANED, ["/tmp/rebase-verify-agent-run-x"]);
  });
}

test("the consent mentions the local log only for agents, and carries the API notice", () => {
  const api = consentText(agentEntry("anthropic-api", { kind: "api", label: "Anthropic API (your key)" }));
  assert.doesNotMatch(api, /agent-log/);
  assert.match(api, /unset ANTHROPIC_API_KEY/);
  assert.match(consentText(agentEntry("omp")), /agent-log\.jsonl/);
  assert.match(api, /compaction summaries/);
});

test("the API run's stderr notice is silenced, the consent already says it", async () => {
  const ui = fakeUi();
  const { deps, state } = fakeDeps();
  await run(ui, deps);
  assert.equal(typeof state.ran[0].warn, "function");
  assert.equal(state.ran[0].warn(), undefined);
});

test("a model the agent refuses is named by the id that was chosen", async () => {
  const ui = fakeUi();
  const { ModelNotOfferedError } = await import("../src/agents/acp.mjs");
  const { deps } = fakeDeps({
    runWithAgent: async () => {
      throw new ModelNotOfferedError("m2");
    },
  });
  assert.equal(await run(ui, deps), 2);
  assert.ok(ui.calls.some((c) => c[0] === "log.error" && /model "m2"/.test(c[1])));
});

test("the wizard refuses flags that belong to a sub-command", () => {
  const has = (set) => (f) => set.includes(f);
  assert.equal(rejectedFlags(has([])), null);
  assert.match(rejectedFlags(has(["narrative-file"])), /^--narrative-file needs a sub-command/);
  assert.match(rejectedFlags(has(["narrative-file", "dry-run"])), /^--narrative-file and --dry-run need a sub-command/);
});

test("no SIGINT or SIGTERM listener is left when submit runs", async () => {
  const ui = fakeUi({ select: [undefined, undefined, "submit"] });
  const orig = ui.select;
  ui.select = async (o) => {
    const v = await orig(o);
    return v === undefined ? o.initialValue ?? o.options[0].value : v;
  };
  const proc = new EventEmitter();
  let during = null;
  const { deps } = fakeDeps({ submit: async () => (during = [proc.listenerCount("SIGINT"), proc.listenerCount("SIGTERM")]) });
  assert.equal(await runWizard({ ui, deps, flags: { version: "1" }, out: "out", proc, now: () => 0 }), 0);
  assert.deepEqual(during, [0, 0]);
});

test("the live status never writes a line wider than the terminal", () => {
  const writes = [];
  const input = { on() {}, off() {} };
  const live = liveStatus({ onCancel() {}, input, output: { columns: 30, write: (t) => writes.push(t) }, style: (_c, t) => t, delay: 1e6 });
  live.start("x");
  live.message("Classifying practices · batch 12 of 40 · 123.4k tokens · $12.34");
  const line = writes.at(-1);
  assert.ok(line.length <= 29, `${line.length}: ${line}`);
  assert.match(line, /…$/);
  live.stop("");
});
