// The interactive path of `npx rebase-verify`: read the sources, choose an
// agent and a model, consent, run, show the profile, offer to submit. It holds
// decisions and copy only; every step that touches the logs, the agents or
// the disk is injected, and the bin passes the same functions the sub-commands
// use. `ui` is the @clack/prompts surface.
import { AgentAuthError, AgentStartError, ModelNotOfferedError, ToolUseError } from "./agents/acp.mjs";
import { RUN_SYSTEM } from "./agents/run.mjs";

const REDRAW_MS = 100;
const tick = () => new Promise((r) => setImmediate(r));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const kilo = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function money(c) {
  const amount = Number(c?.amount);
  if (!Number.isFinite(amount)) return null;
  return c.currency === "USD" || !c.currency ? `$${amount.toFixed(2)}` : `${amount.toFixed(2)} ${c.currency}`;
}

/** The spinner message for a step and what the event stream has reported so far. */
export function statusLine(status, { chars = 0, tokens = null, cost = null } = {}) {
  const parts = [];
  if (status.step === "narrative") parts.push("Writing the narrative", `${kilo(chars)} chars`);
  else parts.push("Classifying practices", `batch ${status.batch} of ${status.total}${status.retry ? " (again)" : ""}`);
  if (tokens != null) parts.push(`${kilo(tokens)} tokens`);
  const m = cost ? money(cost) : null;
  if (m) parts.push(m);
  return parts.join(" · ");
}

/** What the person agrees to, in the words of the agent that will run. */
export function consentText(agent) {
  const lines = [];
  if (agent.kind === "api") {
    lines.push(`These go to the Anthropic API with your key:`);
  } else {
    lines.push(`These go to ${agent.label} and to its model provider:`);
  }
  lines.push(
    `- the narrative input: project labels, README and CLAUDE.md excerpts, dependency names, commit subjects and sampled prompts;`,
    `- up to 60 sessions × 12 of your own messages, redacted, so the practices can be classified.`,
    ``,
    `rebase receives nothing until you choose to submit.`,
    `A local log of the exchange is written to out/agent-log.jsonl.`,
  );
  if (agent.kind === "api") {
    lines.push(`No tools are involved: it is a plain request.`);
  } else if (agent.id === "omp" || agent.id === "claude-code") {
    lines.push(`${agent.label} starts with its tools switched off, and the run stops if it tries to use one.`);
  } else if (agent.id === "codex") {
    lines.push(`${agent.label} runs read-only with an instruction not to use tools, and the run stops if it tries to use one.`);
  } else {
    lines.push(`Whether ${agent.label} lets us switch its tools off is not known. The run stops if it tries to use one, and nothing it wrote is kept.`);
  }
  if (agent.id === "omp" || agent.id === "codex") {
    lines.push(`${agent.label} keeps a transcript of the run; rebase-verify removes it afterwards and never reads it.`);
  }
  return lines.join("\n");
}

const NO_AGENT_NOTE = [
  `rebase-verify writes your profile with a coding agent you already use,`,
  `and none was found on this machine (and no ANTHROPIC_API_KEY is set).`,
  ``,
  `Two ways forward:`,
  `1. Install one of the tested agents, then run this again:`,
  `   - oh-my-pi (omp): install omp from https://github.com/can1357/oh-my-pi`,
  `   - Claude Code: install Claude Code from https://claude.com/claude-code`,
  `   - Codex: install Codex from https://github.com/openai/codex`,
  `2. Or use the /rebase-verify slash command from a clone of the repository,`,
  `   inside the agent you use.`,
].join("\n");

/**
 * @param {object} p
 * @param {object} p.ui clack: intro, outro, cancel, note, log, spinner, multiselect, select, confirm, isCancel
 * @param {object} p.deps sources, readSource, combine, availableAgents, defaultAgent, prepare,
 *   startAgent, runWithAgent, finish, submit
 * @param {{ version?: string, agent?: string, model?: string }} p.flags
 * @returns {Promise<number>} the process exit code
 */
export async function runWizard({ ui, deps, flags = {}, out, proc = process, now = Date.now }) {
  const ctl = new AbortController();
  const stop = () => ctl.abort();
  let session = null;
  let runDir = null;
  let sessionHandedOver = false;

  const closeSession = async () => {
    if (session && !sessionHandedOver) {
      try {
        await session.close();
      } catch {
        // the run's own outcome stays
      }
    }
    session = null;
  };
  const cancelled = async (v) => {
    if (!ui.isCancel(v)) return false;
    await closeSession();
    ui.cancel("Stopped. Nothing was sent.");
    return true;
  };

  ui.intro(`rebase-verify${flags.version ? ` ${flags.version}` : ""}`);

  // 1. Sources, one spinner each so the counts appear as they finish.
  const found = [];
  for (const src of deps.sources) {
    const s = ui.spinner();
    s.start(`Reading ${src.label}`);
    await tick();
    let bundle = null;
    try {
      bundle = deps.readSource(src.id);
    } catch {
      bundle = null;
    }
    const n = bundle?.sessions?.length ?? 0;
    s.stop(bundle ? `${src.label}: ${plural(n, "session")}` : `${src.label}: could not be read`);
    if (n > 0) found.push({ ...src, bundle, count: n });
  }
  if (!found.length) {
    ui.cancel("No sessions found in your logs, so there is nothing to build a profile from. Nothing was sent.");
    return 1;
  }
  const chosen = await ui.multiselect({
    message: "Which sources should the profile be built from?",
    options: found.map((f) => ({ value: f.id, label: f.label, hint: plural(f.count, "session") })),
    initialValues: found.map((f) => f.id),
    required: true,
  });
  if (await cancelled(chosen)) return 130;
  const picked = found.filter((f) => chosen.includes(f.id));

  // 2. The profile inputs, from the chosen sources only.
  const sessionsBySource = Object.fromEntries(found.map((f) => [f.id, f.count]));
  const ps = ui.spinner();
  ps.start("Building your profile from the logs");
  await tick();
  let prepared;
  try {
    prepared = deps.prepare(deps.combine(picked.map((f) => f.bundle)));
  } catch (e) {
    ps.error(`Could not build the profile: ${e.message}`);
    return 1;
  }
  ps.stop("Profile inputs ready");

  // 3. Agent.
  const agents = deps.availableAgents(sessionsBySource);
  if (!agents.length) {
    ui.note(NO_AGENT_NOTE, "No coding agent found");
    ui.cancel("Nothing was written or sent.");
    return 1;
  }
  let agent;
  if (flags.agent) {
    agent = agents.find((a) => a.id === flags.agent);
    if (!agent) {
      ui.log.error(`Agent "${flags.agent}" is not installed. Found: ${agents.map((a) => a.id).join(", ")}.`);
      return 2;
    }
  } else {
    const first = deps.defaultAgent(agents);
    const id = await ui.select({
      message: "Which agent should write your profile?",
      options: agents.map((a) => ({
        value: a.id,
        label: a.label,
        hint: `${plural(a.sessions, "session")} in your logs · ${a.tested ? "tested" : "not tested"}`,
      })),
      initialValue: first.id,
    });
    if (await cancelled(id)) return 130;
    agent = agents.find((a) => a.id === id);
  }

  // The agent is started once: its models are read from the session the run then uses.
  const fail = async (e) => {
    await closeSession();
    if (e?.name === "AbortError" || ctl.signal.aborted) {
      ui.cancel("Stopped. Nothing was sent.");
      return 130;
    }
    if (e instanceof AgentAuthError) ui.log.error(`${agent.label} is not logged in: ${agent.loginHint}.`);
    else if (e instanceof ToolUseError) ui.log.error("The agent tried to use a tool; nothing it wrote was kept.");
    else if (e instanceof ModelNotOfferedError) ui.log.error(`${agent.label} does not offer model "${e.model ?? flags.model}"${e.offered?.length ? `. It offers: ${e.offered.join(", ")}` : ""}.`);
    else if (e instanceof AgentStartError) ui.log.error(`${e.message}.`);
    else ui.log.error(e?.message ?? String(e));
    ui.cancel("Nothing was sent.");
    return 2;
  };

  const live = { chars: 0, tokens: null, cost: null };
  let paint = () => {};
  const onEvent = (e) => {
    if (e.kind === "started") runDir = e.cwd;
    else if (e.kind === "turn-start") live.chars = 0;
    else if (e.kind === "agent_message_chunk" && e.content?.type === "text") live.chars += e.content.text.length;
    else if (e.kind === "usage_update") {
      if (Number.isFinite(e.used)) live.tokens = e.used;
      if (e.cost) live.cost = e.cost;
    } else return;
    paint();
  };

  proc.on("SIGINT", stop);
  proc.on("SIGTERM", stop);
  try {
    let model;
    if (agent.kind === "api") {
      model = flags.model;
    } else {
      const s = ui.spinner();
      s.start(`Starting ${agent.label}`);
      try {
        session = await deps.startAgent(agent.spec({ system: RUN_SYSTEM }), { logFile: `${out}/agent-log.jsonl`, signal: ctl.signal, onEvent });
      } catch (e) {
        s.error(`Could not start ${agent.label}`);
        return await fail(e);
      }
      s.stop(`${agent.label} is ready`);
      const models = session.models ?? [];
      if (flags.model) {
        if (!models.some((m) => m.id === flags.model)) return await fail(Object.assign(new ModelNotOfferedError(flags.model), { offered: models.map((m) => m.id) }));
        model = flags.model;
      } else if (models.length) {
        const m = await ui.select({
          message: "Which model?",
          options: models.map((o) => ({ value: o.id, label: o.name ?? o.id, hint: o.id === session.currentModel ? "current" : undefined })),
          initialValue: session.currentModel ?? models[0].id,
        });
        if (await cancelled(m)) return 130;
        model = m;
      } else {
        ui.log.info(`${agent.label} offers no model choice: its default model will be used.`);
      }
    }

    // 4. Consent.
    ui.note(consentText(agent), "Before anything is sent");
    const ok = await ui.confirm({ message: `Send this to ${agent.label} and continue?`, initialValue: true });
    if (await cancelled(ok)) return 130;
    if (!ok) {
      await closeSession();
      ui.cancel("Stopped. Nothing was written or sent.");
      return 0;
    }

    // 5. The run, with live status.
    const spin = ui.spinner();
    spin.start(`Starting the run with ${agent.label}`);
    let status = { step: "narrative" };
    let last = -Infinity;
    paint = () => {
      const t = now();
      if (t - last < REDRAW_MS) return;
      last = t;
      spin.message(statusLine(status, live));
    };
    let result;
    try {
      sessionHandedOver = true;
      result = await deps.runWithAgent({
        agent,
        model,
        narrativeInput: prepared.narrativeInput,
        practicesInput: prepared.practicesInput,
        logFile: `${out}/agent-log.jsonl`,
        signal: ctl.signal,
        session: session ?? undefined,
        runDir: runDir ?? undefined,
        onStatus: (s) => {
          status = s;
          live.chars = 0;
          last = -Infinity;
          paint();
        },
      });
    } catch (e) {
      sessionHandedOver = false;
      spin.error(ctl.signal.aborted || e?.name === "AbortError" ? "Stopped" : `${agent.label} could not finish`);
      return await fail(e);
    }
    spin.stop("The narrative and the practices are ready");
    session = null;

    // 6. The profile.
    const done = deps.finish(prepared, result);
    const rows = (done.practices ?? []).map((p) => `  ${p.id}: seen in ${p.seen} of ${p.of}`);
    ui.note(
      [
        `${plural(done.sessions, "session")} read, ${plural(done.products, "product")}.`,
        ...(rows.length ? [``, `How the work is done (sessions where it was seen):`, ...rows] : []),
        ``,
        `Read the full profile: ${done.file}`,
      ].join("\n"),
      "Your profile",
    );
    const next = await ui.select({
      message: "What next?",
      options: [
        { value: "submit", label: "Send it to rebase now" },
        { value: "exit", label: "Exit", hint: "send later with: npx rebase-verify submit --yes" },
      ],
      initialValue: "exit",
    });
    if (await cancelled(next)) return 130;
    if (next === "submit") {
      await deps.submit();
      ui.outro("Sent.");
    } else {
      ui.outro("Done. Nothing was sent.");
    }
    return 0;
  } finally {
    proc.off("SIGINT", stop);
    proc.off("SIGTERM", stop);
    await closeSession();
  }
}
