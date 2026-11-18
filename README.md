# rebase-verify

> `rebase-verify`: show rebase how you work, and get verified for it.

Credit where it is due: this is [`letsrebase/rebase-verify`](https://github.com/letsrebase/rebase-verify), rebase's fork of [apply-new](https://github.com/Play-New/apply-new) by Play New, released under the MIT licence. rebase adapts it so that freelancers in the rebase community can send their work profile to the rebase hub, where a person reviews it before it counts for anything. If approved, the profile earns «Verificato da rebase» and companies rebase works with can see its summary, its domains of work and the sectors of its representative projects, next to your name and your card, for example in the talent cloud or when rebase proposes you for a project (written by your own model, reviewed by you); its text is also used to write your anonymous card. It is kept at most 12 months and you can delete it from your member area. `submit` sends to rebase, never to Play New. Changes that fit the original go back upstream as pull requests; how the two are kept apart is in [AGENTS.md](AGENTS.md).

A CV is a list of what you did, formatted for keyword scans. For work that happens inside agent logs, it's the wrong surface. The signal that matters (how you decompose, how you verify, what you do when the model misunderstands) already exists in your agent sessions, whichever CLI they happen to live in. A resume can't see it.

This tool makes it visible. You run it on your laptop, you see the profile before anyone else does, and you decide whether to send it to rebase. The tool doesn't score you; if a person at rebase approves the profile, it earns «Verificato da rebase», which the talent cloud lists first. The profile describes how you work, and it opens a conversation.

## You'll need

Node 20 or newer, Claude Code installed, and a Claude subscription (Pro, Max, or Enterprise). No API key.

## How it goes

```
git clone https://github.com/letsrebase/rebase-verify
cd rebase-verify
claude
> /rebase-verify
```

The slash command reads your Claude Code history and lets your own Claude write a short profile about you. It asks nothing about who you are. Two files come out in `out/`: `profile.md` for humans, `candidate.json` for agents. Submission is a second step. You can keep the profile for yourself.

```
node bin/rebase-verify.mjs submit --yes
```

## Sources

The tool reads every supported agent CLI it finds on your machine and folds them into one profile. Each source is disclosed in the profile's `sources` block with its capture level: *full* means tamper-evident records the authenticity screen can verify, *structural* means well-formed data without a verification story.

| | Reads from | Skip with | Capture |
|---|---|---|---|
| [![Claude Code](https://img.shields.io/badge/Claude_Code-555?logo=claudecode&logoColor=white)](https://claude.com/claude-code) | `~/.claude/projects` | always read (`--root` points it elsewhere) | full |
| [![opencode](https://img.shields.io/badge/opencode-555?logo=opencode&logoColor=white)](https://opencode.ai) | `~/.local/share/opencode` (sqlite; JSON fallback via `--opencode-json`) | `--no-opencode` | structural |
| [![Codex CLI](https://img.shields.io/badge/Codex_CLI-555)](https://github.com/openai/codex) | `~/.codex/sessions` | `--no-codex` | structural |
| [![pi](https://img.shields.io/badge/pi-555?logo=pi&logoColor=white)](https://pi.dev) | `~/.pi/agent/sessions` | `--no-pi` | structural |
| [![cursor-agent](https://img.shields.io/badge/cursor--agent-555?logo=cursor&logoColor=white)](https://cursor.com/cli) | `~/.cursor/chats` (sqlite; needs Node 22.5+, otherwise read as empty and disclosed) | `--no-cursor` | structural |
| ![kimi-code](https://img.shields.io/badge/kimi--code-555?logo=moonshotai&logoColor=white) | `~/.kimi-code/sessions` | `--no-kimi` | structural |

Every source normalizes into the same session model, so all seven lenses below read them identically. Each `--<source>-root <dir>` flag overrides the default location. What never gets opened per source (credential files, config, telemetry) is enumerated in [PRIVACY.md](PRIVACY.md). Gemini CLI and ChatGPT / Claude.ai exports are on the roadmap.

## What we look at

Seven lenses, all built from your logs.

**What you work on.** Three to five fields of work, derived from the evidence of every product in your logs (type of work, stack, code areas, research topics). Each domain carries a count of products and sessions, never a name: "talent operations, 8 products, 14 sessions".

**How you reason.** Cognitive tags derived from concrete signals: *research-first* if your read-to-edit ratio is above 2, *orchestrator* if you delegate to sub-agents 15+ times, *verification-heavy* if checks run in half your projects, *risk-calibrated* if your revert-to-commit ratio stays below 10%. A short paragraph from your Claude on decomposition, verification, error handling, calibrated trust.

**How you work with the model.** One continuous axis from *directing* (long structured prompts, file paths, acceptance criteria) to *co-thinking* (short conversational turns, open questions, the model as a partner). The midpoint is co-construction. Most people switch by context, and the narrative says when.

**How deeply Claude is your practice.** Active days over the observed window, median sessions per active day, session depth, longest streak, peak day. The difference between *daily driver, deep sessions* and *occasional, short bursts on specific tasks*.

**How you spread your work.** Sessions per product, concentration on your top products, products carried across months. Two sessions each across twenty products reads as portfolio steering; nine sessions each across nine products reads as sustained building. Both are legitimate shapes, and they match different projects.

**How long you have used each technology.** For every technology the stack detection saw (always a public label such as Supabase or Playwright, never a repo, client or private package name), how many sessions, products and distinct calendar months it appears in, and the first and last month. A plain-language band labels the month counts: *continuous* (6+ months, and present in at least 75% of the months between its first and last), *recurring* (3+ months), *occasional* (1 to 2 months). The thresholds are empirical, like the cognitive-tag ones, and the band is a label for the counts printed next to it, never a score. The stack is detected per product, so the session count means "sessions in products where the technology was detected", an upper bound on sessions that touched it. Months are bucketed in the same `--tz` as the day counts, and no model is involved. At submit the month window (first month, last month, month count) and the band are hard checks against your logs; session and product counts and the presence of a technology depend on your repos as they are on disk now, so a difference there is a warning, not a block.

**How fluent you are in the agentic stack.** Three axes: what you use (sub-agents, MCP servers, slash commands you invoke), what you build (skills, commands, hooks, the `CLAUDE.md` files you maintain), and how you organise work (planning, subtask tracking, clarifying before assuming). All counts. Custom MCP servers and custom skills are counted but never named (they can carry client information).

Plus a trajectory block (how your behavior shifted across the observed window), three to five representative projects (adaptive: flagships by significance, extra slots only for type diversity or comparable significance), each carrying per-product orchestration counts: sessions per agent CLI (with overlapping vs disjoint activity periods), sub-agent delegations, and headless agent-dispatch commands (to the same tool or another; all lower bounds), and a groundedness check (the prose has to track back to the data; below 60%, submission is blocked).

At submit time everything is re-checked, not trusted: groundedness is recomputed on the file as it is now, the structured numbers are re-derived from your logs (the profile can't claim more sessions or commits than the logs contain), and the intake recomputes groundedness and the structural invariants server-side on what it receives. An incoherent hand-edit of `candidate.json` doesn't survive the trip; the log-level re-derivation runs only on your machine, since your logs never leave it.

The profile also discloses its own coverage: a `sources` block records which log sources were read, at what capture level (*full* = tamper-evident records the authenticity screen can verify; *structural* = well-formed data without a verification story), and how many sessions each contributed. The window and every count are **lower bounds** of your real activity, logs rotate and old sessions are pruned, so what the tool can still see is never more than what you did. Like the authenticity score, this is a screen, not proof.

## Work practices

The profile also carries counts of seven work practices. They are counted by code from the tool calls and file paths your logs already contain. No model is involved and nothing new is read. Each one is shown as "seen in N of M sessions", with the number of products and months it spans. It is never a score, a percentage or a total, and nothing here says anything about tone, skill or character. You can read the counts in the "How the work is done" section of `out/profile.md` before you submit anything. That section only appears when at least one practice could be counted in your sessions.

Each practice is counted against the sessions where it could have happened (M):

- `checks_before_commit`: After the last file edit before a git commit, a check ran in the session: tests, a linter, a type check or a build. M is the sessions with a commit.
- `tests_with_changes`: Both a source file and a test file were edited in the session. M is the sessions that edited a source file.
- `failure_reproduced_before_fix`: A check command (tests, a linter, a type check or a build) failed, files were edited, and then the same check succeeded in the session. M is the sessions where a check command failed.
- `plan_before_edit`: A planning step came before the first file edit in the session: plan mode, a task list, or writing a plan or spec file. M is the sessions with an edit.
- `reviews_changes`: Before a commit or a pull request, the diff appeared in the session (git diff, git show or gh pr diff), whoever asked for it; the session cannot show whether anyone read it. M is the sessions with a commit or a pull request.
- `design_documents`: A design document (an ADR, RFC, spec or design file, by path) was written or edited in the session. M is the sessions with an edit.
- `security_checks`: A dependency audit or a security scanner ran in the session. M is the sessions with an edit.

How it is read:

- **Paths.** Paths are compared lower-cased, with a backslash read as a forward slash, and read relative to the project folder of the session, so a folder above the project named `test` or `specs` changes nothing. A test file is one under a `test/`, `tests/`, `__tests__/` or `spec/` folder, or named `*.test.*`, `*.spec.*`, `*_test.*` or `test_*.py`. A design document is one under an `adr/`, `rfcs/`, `docs/rfc/`, `docs/design/` or `specs/` folder, or named `adr-*`, `*-adr.md`, `rfc*`, `design.md`, `*-design.md` or `*-spec.md`. A plan is one under a `plans/` or `specs/` folder, or named `plan.md`, `*-plan.md` or `*-spec.md`. So a spec file counts as a plan, and an ADR does not. A source file is a code file by extension: `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.mts`, `.cts`, `.tsx`, `.vue`, `.svelte`, `.py`, `.go`, `.rs`, `.java`, `.kt`, `.kts`, `.scala`, `.rb`, `.php`, `.cs`, `.c`, `.cc`, `.cpp`, `.h`, `.hpp`, `.swift`, `.m`, `.dart`, `.ex`, `.exs` or `.lua`. Other files such as `.sql`, `.sh`, `.html` or `.css` are not source files. A test file is never a source file, and config files (`*.config.*`), type declarations (`*.d.ts`), `conftest.py`, `setup.py` and anything under `docs/` are not counted as source files either.
- **Commands.** rebase-verify reads each command up to its first 240 characters, so a check at the end of a long chained command can be missed. Leading environment assignments and runner wrappers such as `npx`, `uv run`, `python -m` and `pnpm exec` are skipped before a command is matched.
- **Reviews.** `reviews_changes` means the diff appeared in the session, whoever asked for it. It does not mean anyone read it. Options that list files or statistics instead of the diff, such as `--stat` and `--name-only`, and `git show <rev>:<path>`, do not count as a diff appearing.
- **Failures.** `failure_reproduced_before_fix` only counts failed checks. A failed command that contains a check counts as a failed check, and in a chain such as `npm test && git push` the exit status cannot say which part failed, so the chain counts as its first check. Two runs are the same check when their command words match (the words before the first flag or path, wrappers dropped), so a narrower rerun of the same check (`pytest tests/a.py` after `pytest`) is the same command. Pi and Cursor sessions are left out of this practice, because their logs cannot show a failure reliably. A session whose adapter cannot give a field for a practice is left out of that practice rather than counted as not seen.
- **Sessions with no time.** A session with no timestamped message cannot be placed in a month, so it is left out of every practice's counts. A practice no session could show (M is 0) is left out of the profile.
- **Counts only.** Only the counts leave your machine, never a command, a path or a file name.

The full rules are in `share/practices.json`, generated from `src/practices-rules.mjs`: every command pattern, the path patterns, the source extensions, the commit and pull request patterns, and the tool names read as a planning step or an edit.

## What it isn't

It isn't a personality test, and the cognitive tags are descriptive: there's no "better" tag, only different patterns. The profile doesn't compare you with anyone else, and it doesn't predict performance.

It doesn't score you. The only scores in the pipeline (authenticity, groundedness) measure the *report's* integrity: whether the logs are internally consistent and the prose tracks the data, never you. Nothing counts until a person at rebase has read the profile and approved it. Approval means three things: your profile carries «Verificato da rebase», and the talent cloud lists verified talents first; companies rebase works with can see its own summary, its domains of work and the sectors of its representative projects, next to your name and your card (for example in the talent cloud or when rebase proposes you for a project), which your own model wrote and you reviewed; and the profile's text is used to write your anonymous card, through the AI provider named in [rebase's privacy notice](https://letsrebase.com/privacy). Deleting the profile does not remove «Verificato da rebase»; write to ciao@letsrebase.com to have it removed. A person decides; the tool never does.

It doesn't replace a conversation. The decision about humans stays with humans.

## What we send, what we don't

You sign in to rebase in your browser when you send, so rebase knows it is you: no name, email or city goes with the profile, and the tool no longer asks for them. What is sent is the profile JSON (counts, abstract domains, tags, a short narrative, and any artifact *link* you chose to add). We don't see client names, product names, person names, repository names, your code, or your raw logs. The redaction runs on your machine before anything leaves it. rebase takes no attached files: an artifact has to be a link.

The profile waits as a draft until a person at rebase reviews it. It is kept at most 12 months, and you can delete it from your member area at any time. Locally, everything the tool generated lives in the `out/` folder: delete it and it's gone.

## Policy

Legal basis: explicit consent (GDPR Art. 6(1)(a)). You run `submit --yes` after seeing what's in the payload, and you can read the exact payload first with `submit --dry-run`. The controller is the one named in [rebase's privacy notice](https://letsrebase.com/privacy). Retention: at most 12 months from the day you send it, and you can delete it earlier from your member area. Your rights (access, rectification, erasure, portability, objection) are exercised by writing to ciao@letsrebase.com.

Under the EU AI Act (Regulation 2024/1689), systems that filter job applications and evaluate candidates are classified high-risk (Annex III §4(a)). We treat the work profile that way. Transparency: this README and the source on GitHub. Human oversight: no automated decision; a person at rebase reads each profile, and only that person's approval verifies it. Disclosure: you're interacting with an AI tool. Data governance: raw logs stay local, only a consented subset is transmitted, retention is declared. Full text in [PRIVACY.md](PRIVACY.md).

## Limits

You decide which projects rebase sees, so the tool can't see what's missing. Logs of solo work mostly show execution, which means leadership, mentoring, and the work of being with humans is invisible from here. The thresholds (read-to-edit above 2, ≥15 delegations) are empirical: we don't know yet how they hold across hundreds of people. The narrative is written by a model; the prompt constrains it, it doesn't make it neutral. A person at rebase reads each profile by hand, and we're still learning what to look for.

If you spot something we should change, [open an issue](https://github.com/letsrebase/rebase-verify/issues).

## Commands

| | |
|---|---|
| `generate` *(default)* | full profile, locally |
| `prepare` | only `out/narrative-input.json`, for writing the narrative manually |
| `finalize --narrative-file out/narrative.json` | finalize after `prepare` |
| `submit --dry-run` | write the exact outgoing payload to `out/payload-preview.json`, send nothing |
| `submit --yes` | sign in to rebase in the browser, then send the profile; a person at rebase reviews it |

All commands run as `node bin/rebase-verify.mjs <sub>` or as `rebase-verify <sub>` after `npm link`. Common flags: `--top N` (force the project count; default is adaptive 3–5), `--root <dir>`, the per-source roots and opt-outs from the Sources table above, `--hub <url>` (where `submit` sends; default `https://letsrebase.com`, also settable with `REBASE_VERIFY_HUB_URL`; `--hub preview` means `https://preview.letsrebase.com`), `--tz <IANA zone>` (bucket the day and month counts (active days, streak, technology-usage months) in your timezone instead of the UTC default; the zone you choose is recorded in the profile, which is also why UTC is the default: a zone names a place, and nothing location-shaped should leave your machine unless you opt in). Without Claude Code, set `ANTHROPIC_API_KEY` and the narrative goes through the API instead of your subscription, note that on this path the narrative input (project labels, README/CLAUDE.md excerpts, dependency names, commit subjects, sampled prompts) is sent to api.anthropic.com under your own key, before any name-stripping; the tool warns when this happens, and an explicit `--narrative-file` always takes precedence over the key. The subscription and manual paths stay fully local until submit. Details in [PRIVACY.md](PRIVACY.md).

## Tests

```
npm test
```

## Contributing

PRs and issues are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the rules
that make this repo unusual (schema discipline, privacy boundaries, the
[ADR-001](docs/adr/001-just-a-report.md) frame, the current six-source policy).
Security issues go privately via [SECURITY.md](SECURITY.md), never as public issues.

## License

MIT. See [LICENSE](LICENSE).
