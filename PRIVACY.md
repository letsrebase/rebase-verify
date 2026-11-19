# Privacy & policy: rebase-verify

Last updated: 2026-11-19

rebase-verify is a tool that turns your Claude Code logs into an anonymised work profile that you send to rebase, the freelance community at letsrebase.com. It is a report (a photograph of how you work with AI), not a score and not an automated decision about you: a person at rebase reads it and decides whether to approve it, and approval gives you «Verificato da rebase». It is a fork of [apply-new](https://github.com/Play-New/apply-new) by Play New; the privacy terms here are rebase's, not Play New's.

This document explains what we do with the data you choose to send.

---

## 1. Who we are

**Data controller:** Rebase S.r.l., Via Podgora 11, 20122 Milano (MI), Italy; VAT and tax code IT 14971460960; REA MI-2819107; PEC [rebase.srl@legalmail.it](mailto:rebase.srl@legalmail.it). It is the controller named in [rebase's privacy notice](https://letsrebase.com/privacy), which also covers the rest of letsrebase.com.
Contact: [ciao@letsrebase.com](mailto:ciao@letsrebase.com)

## 2. What we collect, with your consent

When you run `rebase-verify submit --yes`, you first sign in to rebase in your browser (the tool shows a code, opens a page on letsrebase.com and waits until you press «Autorizza»). rebase learns who you are from that sign-in, so the tool sends no contact fields. Then the following is transmitted:

- **A `playnew-profile/v1` JSON** containing: time window, session and product counts, a sources block (which log sources were read, their capture level and session counts, no paths or machine identifiers), per representative project (abstract domain description, type tags, technology stack, signals like commits/reverts/checks, and orchestration counts: how many sessions each agent CLI contributed to the product, whether their activity periods overlapped, sub-agent delegation counts, and how many shell commands dispatched work to an agent CLI headless, the same tool or another; tool names and counts only, never the commands themselves), cognitive tags (e.g. *research-first*), a short narrative written by the coding agent you choose, a learning trajectory block (behavioral shifts, topic clusters, vocabulary adopted, principles codified), an AI-relationship axis (*directing* ↔ *co-thinking* split), an agentic-literacy block (counts of how you use / build / design with the agentic stack, never names), a practice-intensity block (how deeply Claude is embedded in your daily workflow, including the timezone the day counts are bucketed in, which is `UTC` unless you pass `--tz`), a technology-usage block (for each technology the stack detection saw: sessions, products and distinct calendar months it appears in, first and last month, and a band label derived from those counts; names come only from the detector's fixed list of public technology labels, so a custom or private dependency never appears, and months are bucketed in the same timezone as the day counts), and a list of other projects in inventory.
- **Counts of work practices** in the profile: eleven practices, each as in how many sessions it was seen out of how many it could have been, with product and month counts. Seven are counted by code on your machine from the tool calls and file paths the tool already reads (a check ran after the last edit before a commit, tests edited with source, a failed check followed by a fix and a passing rerun, a planning step before the first edit, a diff shown before a commit or a pull request, a design document written, a security scan run). Four are classified by your own model (asking for alternatives, pushing back with a reason, stating when the work is done, limiting the scope): the classification reads only your own messages (Claude Code sub-agent briefs, task notifications, compaction summaries and opencode child sessions are skipped; a session another tool's agent drove can still be read as typed by you) from at most 60 sampled sessions, at most 12 messages each, already redacted, and never the agent's replies or your files. The model that answers is the one you already use (the agent in Claude Code, or your own API key); rebase never receives the messages. Only the counts leave, never commands, paths or file names, and never messages. The per-session answers stay in `out/practices-detail.json` on your machine and are never sent. The slash command's clean-up step deletes the input, sample and answers files; with `generate` or a manual `prepare` and `finalize` they stay in `out/` until you delete it, and the next `prepare` replaces them. The hub marks the four as coming from your own model and not rechecked. With the slash command the messages go to whatever provider your agent already uses; with `generate` and `ANTHROPIC_API_KEY` set they go to api.anthropic.com under your key (see 2a). The definitions are in the README under "Work practices".
- **Opt-in artifact links** you explicitly add (a deploy URL, a repo URL, a PR link, your choice, never required). rebase takes no attached files, so a screenshot has to be a link.

What we **never** collect: your name, email or city from the tool (the sign-in identifies you), client names, product names, person names, repository names, your code, your raw logs, or attached files. Framework-injected text in the logs (tool reminders, instruction dumps, attached-file wrappers) is filtered out before anything is counted or sampled, and is never treated as your own words.

The narrative is written under hard constraints: no proper names, evidence-based only, no hyperbole. A pre-submit *groundedness check* verifies that the prose anchors (numbers, technology names, type tags, year-months) trace back to the structured data.

**Sources we read locally.** rebase-verify reads your Claude Code logs (`~/.claude/projects`) and, when present, your [opencode](https://github.com/sst/opencode) logs (its `~/.local/share/opencode/opencode.db`, or the JSON cache under `…/storage` with `--opencode-json`; skip opencode entirely with `--no-opencode`), your [Codex CLI](https://github.com/openai/codex) logs (`~/.codex/sessions/**/*.jsonl` only: `auth.json`, `config.toml`, `history.jsonl`, and any sqlite files under `~/.codex` are never opened; skip codex entirely with `--no-codex`), your [pi](https://pi.dev) logs (`~/.pi/agent/sessions/**/*.jsonl` only: `auth.json`, `settings.json`, `models.json`/`models-store.json`, and `trust.json` are never opened; skip pi entirely with `--no-pi`), your [oh-my-pi](https://github.com/can1357/oh-my-pi) logs (`~/.omp/agent/sessions`, the top-level session files only: the subagent and advisor transcripts, `changes.jsonl` and tool-output blobs inside each per-session folder, and anything else under `~/.omp` are never opened; skip oh-my-pi entirely with `--no-omp`), your [cursor-agent](https://cursor.com) logs (`~/.cursor/chats/**/store.db` only; each per-session database is copied and opened read-only; `prompt_history.json`, `cli-config.json`, `projects/`, and macOS Keychain are never opened; skip cursor entirely with `--no-cursor`), and your kimi-code logs (`~/.kimi-code/sessions/**/wire.jsonl` plus each session's own `state.json` only: `config.toml`, `device_id`, `credentials/`, `telemetry/`, `user-history/`, and `session_index.jsonl` are never opened; skip kimi entirely with `--no-kimi`). All seven are read on your machine and reduced to the same redacted, counts-based subset described above. From opencode specifically we keep only what the Claude Code path keeps: tool **outputs** and assistant **error** payloads are dropped (we retain a byte count, never the text), reasoning is reduced to a character count, and file paths and shell commands are passed through the same PII redaction. From codex specifically, the same posture holds: tool output, reasoning text, and `apply_patch` diff bodies are never stored, only character/byte counts survive. From pi specifically, the same posture holds too: tool output, reasoning text, and thinking-signature bytes are never stored, and a local model's filesystem-path model id (which can carry your OS username, including dash-encoded path forms and bare mentions of the local account name) is redacted before it is ever kept. From cursor-agent specifically, the same posture holds too: tool outputs (Write's file contents, an edit's old/new text, a tool-result body) and the model-generated conversation title are never stored, only paths, truncated commands/queries, and byte counts survive; reasoning text is reduced to a character count and its signature to a length; cursor keeps no per-message token usage anywhere in its local storage, so none is read. From kimi-code specifically, the same posture holds too: thinking text, tool outputs, and `config.update`'s system prompt are never stored (only lengths and byte counts survive), and `state.json`'s `title`/`lastPrompt` fields (confirmed verbatim prompt text) are parsed only to read `workDir` and never kept. The same "counts, not names" rule applies to every source.

## 2a. The narrative step: three paths, one caveat

The short prose in your profile is generated in one of three ways, and they differ in what leaves your machine **before** submit:

The main way to run the tool is `npx @letsrebase/verify`, where a coding agent you choose writes the narrative (see 2b). The slash command below is the second way.

- **Slash command path (the second way):** from a clone of the repository, the `/rebase-verify` slash command runs inside your own Claude Code session. The narrative input never goes anywhere your ordinary Claude usage doesn't already go. Fully local until submit.
- **Manual path:** `prepare` writes the narrative input to a local file; you hand-write `narrative.json` and run `finalize`. Nothing leaves your machine until submit. An explicit `--narrative-file` takes precedence over an API key for the narrative only; the practices sample is still sent if the key is set and you run `generate`.
- **API path:** if `ANTHROPIC_API_KEY` is set and no narrative file is given, the narrative input is sent to **api.anthropic.com** under *your own* key: the real labels of your selected projects, a README/CLAUDE.md excerpt (up to 1,200 characters), up to 60 dependency names, 20 commit subjects, and sampled prompts (PII-redacted, but not name-stripped). With `generate`, the model-practices sample goes too, even when a narrative file is given: up to 60 sessions, 12 of your own messages each, 600 characters each, redacted. rebase never sees this exchange; it is between you and Anthropic, governed by Anthropic's API terms. But it does leave your machine before submit, so the tool prints a warning when this path engages. If you work under NDA or prefer everything local, use the subscription or manual path.

The name-stripping described in section 2 (no repository names, no client names in what *we* receive) applies to what is transmitted to rebase at submit; it cannot retroactively apply to what you choose to send to Anthropic via your own key.

## 2b. The coding agent you choose

`npx @letsrebase/verify` (and `generate --agent <id>`) lets a coding agent you pick write the narrative and classify the model practices. You choose the agent and the model; rebase does not.

- **What the agent's model provider receives.** The narrative input: project labels, README and CLAUDE.md excerpts, lines you added to CLAUDE.md or README over time, dependency names, commit subjects, sampled prompts, topics you researched and up to six compaction summaries (see 2a for the sizes). And the practices sample (up to 60 sessions, 12 of your own messages each, 600 characters each, redacted), under that provider's own terms. rebase never receives it. It leaves your machine before submit.
- **Downloads.** The adapters for Claude Code (`@agentclientprotocol/claude-agent-acp`) and Codex (`@agentclientprotocol/codex-acp`) are downloaded from npm with npx when you pick them.
- **Tools.** Each turn runs in its own agent session with a minimal environment. Tools are switched off where the agent allows it (oh-my-pi, Claude Code); Codex runs read-only with an instruction not to use tools; for agents not tested, and as a backstop for all, any tool use stops the run and its answer is thrown away.
- **Transcripts.** oh-my-pi and Codex keep a transcript of the run, which rebase-verify removes and never reads. Claude Code keeps none but leaves an empty folder, which rebase-verify removes.
- **Local log.** `out/agent-log.jsonl` holds every message exchanged with the agent except the answers to initialize and authenticate (your messages and the agent's answers). It stays on your machine, is never sent, and goes when you delete `out/`.
- **What rebase sees.** The profile records the agent and the model that wrote the narrative and classified the practices as `{ agent, model }`. rebase's admins see them next to the practices. The accuracy figures in the README were measured for claude-opus-4-7 through the API prompt; any other agent or model is recorded, not measured.

## 3. Why we collect it (purpose)

To let a person at rebase **review your work profile and, if they approve it, verify it**. Concretely:
- A person at rebase reads the profile, which waits as a draft until then, and approves or declines it.
- Once approved, the profile earns «Verificato da rebase» (which the talent cloud lists first), and companies rebase works with can see the profile's own summary, its domains of work and the sectors of its representative projects, next to your name and your card, for example in the talent cloud or when rebase proposes you for a project. Your own model wrote those texts and you reviewed them before sending; rebase does not rewrite them. The profile's text is also used to write your anonymous card: it is sent to the AI provider that [rebase's privacy notice](https://letsrebase.com/privacy) names as processor, under the terms described there.
- Nothing is shown to anyone outside rebase before that approval.

We **do not**:
- Train AI models on your data.
- Share your profile itself with anyone outside rebase; the companies rebase works with only see the summary, domains of work and representative project sectors of an approved profile, next to your name and your card.
- Use your data to make automated decisions about you.

## 4. Legal basis

**Explicit consent** (GDPR Art. 6(1)(a)). You run `rebase-verify submit --yes` after seeing what is being sent. You can inspect the exact payload before consenting: `rebase-verify submit --dry-run` writes it to `out/payload-preview.json` (repository names and contact already stripped) and sends nothing. Signing in to rebase in the browser, and pressing «Autorizza», is part of the same act. You can withdraw consent at any time by deleting the profile from your member area or by writing to [ciao@letsrebase.com](mailto:ciao@letsrebase.com); deleting the profile does not remove «Verificato da rebase», which you can ask the same address to remove.

## 5. How long we keep it (retention)

We keep a profile for **at most 12 months** from the day you send it, after which it is deleted. Sending a new profile replaces the previous one, which is not kept. A profile a person at rebase declined is deleted on the same schedule.

You can **delete it earlier** at any time from your member area.

## 6. Your rights (GDPR)

You have the right to:
- **Access** the data we hold about you. Your `candidate.json` already is a copy; your member area shows the stored profile's status, and [ciao@letsrebase.com](mailto:ciao@letsrebase.com) sends you what is stored on request.
- **Rectification**: fix anything inaccurate. Easiest: re-generate locally and send again; a new profile replaces the previous one.
- **Erasure**: be deleted. Delete the profile from your member area, or write to [ciao@letsrebase.com](mailto:ciao@letsrebase.com). Deleting the profile does not remove «Verificato da rebase»: write to the same address to have it removed too.
- **Portability**: receive the data in machine-readable form. Again, `candidate.json`.
- **Objection / restriction**: pause processing.
- **Lodge a complaint** with the [Garante per la protezione dei dati personali](https://www.garanteprivacy.it/) (the Italian DPA).

## 7. AI Act notice

Under EU Regulation 2024/1689 (the AI Act), Annex III §4(a), AI systems used to "analyse and filter job applications and evaluate candidates" are classified as **high-risk**. The work profile is treated as such. The obligations we take on:

- **Transparency.** This file and the [README](README.md) describe in plain terms what the tool measures, how the tags are derived, and what the model is asked to do, including the agentic-literacy counts (built-in vs custom, with custom names never exposed), the AI-relationship axis, the trajectory shifts, the per-product orchestration counts (per-CLI session split, agent-dispatch and delegation counts), the technology-usage counts and bands, and the practice-intensity signals. The source code is public on GitHub.
- **Human oversight.** No automated decision is made about you. A person at rebase reads each profile and decides whether to approve it; approval is what verifies it (a «Verificato da rebase» badge, which the talent cloud lists first, and visibility of its summary, domains of work and representative project sectors, next to your name and your card, to companies rebase works with), and nothing counts before it. The AI generates the profile and computes screening metrics; it does not decide anything about you. AI may score the *artifact*, never you: the authenticity and groundedness scores measure whether your logs are internally consistent and whether the prose tracks the data. A refusal is a person's call, not a score's.
- **Disclosure.** You are interacting with an AI tool. The narrative parts of your profile (summary, cognitive narrative, trajectory narrative, per-project descriptions) are model-generated.
- **Data governance.** Raw logs stay on your machine. Only a redacted, consented subset is transmitted, with declared retention. Storage is in the EU. Once a profile is approved, its text is sent to write the anonymous card to the AI provider that [rebase's privacy notice](https://letsrebase.com/privacy) names as processor, and that notice also says where that processing happens and under which safeguards.
- **Logging.** We keep server-side logs of API requests (timestamps, status codes) for security and debugging, separate from the application data.
- **Robustness & accuracy.** The deterministic parts (tags, metrics, groundedness check) are open-source and inspectable. The narrative is constrained by a documented prompt. The groundedness check blocks submissions where the prose drifts from the data below a threshold.

## 8. Security

- Transmission over HTTPS.
- Storage on rebase's servers in the European Union.
- The sign-in token the CLI receives can send one profile and nothing else, expires after 15 minutes and is spent by the first profile it sends. The CLI keeps it in memory only and never writes it to disk.
- The full profile is readable by the people at rebase who review it, directly or through their admin tools; the companies rebase works with see only what section 3 lists, once it is approved.

## 9. A fully manual alternative

If you prefer not to use the tool (for any reason, including unease about the AI generation), write to [ciao@letsrebase.com](mailto:ciao@letsrebase.com). We will arrange a no-tool conversation, after which a person at rebase can verify you the same way. Nothing is required: you stay in rebase, with your card and your member area, whether or not you send a work profile.

## 10. Changes

We will update this document if we change what the tool does. The previous versions stay in the [git history](https://github.com/letsrebase/rebase-verify/commits/main/PRIVACY.md).

---

*If anything here is unclear or you spot a mistake, please [open an issue](https://github.com/letsrebase/rebase-verify/issues) or write to [ciao@letsrebase.com](mailto:ciao@letsrebase.com).*
