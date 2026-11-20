#!/usr/bin/env node
// One command for a release of @letsrebase/verify: `npm run release`.
//
// It asks what kind of release (patch, minor, major), then does what AGENTS.md describes by
// hand: a pull request that bumps the version, CI, the merge, the v<version> tag, the
// publish.yml run (npm trusted publishing) and the wait until npm serves the version with
// its provenance. Every step that fails says what it left behind and how to go on.
//
//   npm run release                       # interactive
//   npm run release -- --dry-run          # show the plan, change nothing
//   npm run release -- patch --card REB-1 --yes   # no questions (patch|minor|major|x.y.z)
//
// Needs git and an authenticated gh with write access to the repository. Not shipped in the
// package (`files` in package.json leaves scripts/ out).
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { styleText } from "node:util";
import * as p from "@clack/prompts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKFLOW = "publish.yml";
const LEVELS = ["patch", "minor", "major"];
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

const bold = (s) => styleText("bold", s);
const dim = (s) => styleText("dim", s);
const cyan = (s) => styleText("cyan", s);
const green = (s) => styleText("green", s);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function bump(version, level) {
  const m = SEMVER.exec(version);
  if (!m) throw new Error(`not a plain x.y.z version: ${version}`);
  const [maj, min, pat] = m.slice(1).map(Number);
  if (level === "major") return `${maj + 1}.0.0`;
  if (level === "minor") return `${maj}.${min + 1}.0`;
  if (level === "patch") return `${maj}.${min}.${pat + 1}`;
  throw new Error(`unknown level: ${level}`);
}

// a > b for plain x.y.z versions
export function isNewer(a, b) {
  const [x, y] = [a, b].map((v) => SEMVER.exec(v).slice(1).map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

export function parseArgs(argv) {
  const opts = { dryRun: false, yes: false, target: null, card: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--yes" || a === "-y") opts.yes = true;
    else if (a === "--card") opts.card = argv[++i] ?? "";
    else if (a.startsWith("--card=")) opts.card = a.slice(7);
    else if (!a.startsWith("-") && !opts.target) opts.target = a;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (opts.target && !LEVELS.includes(opts.target) && !SEMVER.test(opts.target)) throw new Error(`expected patch, minor, major or x.y.z, got ${opts.target}`);
  if (opts.card != null && opts.card !== "" && !/^REB-\d+$/.test(opts.card)) throw new Error(`a card id looks like REB-123, got ${opts.card}`);
  return opts;
}

export function repoFromPackage(pkg) {
  const url = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url ?? "";
  const m = /github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?$/.exec(url);
  if (!m) throw new Error(`package.json repository is not a GitHub URL: ${url}`);
  return m[1];
}

class StepError extends Error {
  constructor(message, hint) {
    super(message);
    this.hint = hint;
  }
}

function run(cmd, args, { allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => reject(new StepError(`${cmd} could not start: ${e.message}`)));
    child.on("close", (code) => {
      if (code === 0 || allowFail) resolve({ code, out: out.trim(), err: err.trim() });
      else reject(new StepError(`${cmd} ${args.join(" ")} failed (exit ${code})\n${(err || out).trim().split("\n").slice(-6).join("\n")}`));
    });
  });
}

const readPkg = () => JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

async function registryVersion(name, version) {
  const res = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2f")}/${version ?? "latest"}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new StepError(`the npm registry answered ${res.status}`);
  return res.json();
}

function bail(error) {
  p.log.error(error.message);
  if (error.hint) p.log.info(error.hint);
  p.outro(styleText("red", "Release stopped."));
  process.exit(1);
}

async function step(title, fn, done) {
  const s = p.spinner();
  s.start(title);
  try {
    const result = await fn((msg) => s.message(msg));
    s.stop(done ? done(result) : title);
    return result;
  } catch (e) {
    s.error(title);
    throw e;
  }
}

async function ask(prompt) {
  const answer = await prompt;
  if (p.isCancel(answer)) {
    p.cancel("Nothing was changed.");
    process.exit(0);
  }
  return answer;
}

async function preflight(pkg, repo) {
  const auth = await run("gh", ["auth", "status"], { allowFail: true });
  if (auth.code !== 0) throw new StepError("gh is not signed in.", "Run gh auth login, then npm run release again.");
  const branch = (await run("git", ["rev-parse", "--abbrev-ref", "HEAD"])).out;
  if (branch !== "main") throw new StepError(`You are on ${branch}, not main.`, "git switch main, then npm run release again.");
  const dirty = (await run("git", ["status", "--porcelain", "--untracked-files=no"])).out;
  if (dirty) throw new StepError("The checkout has uncommitted changes.", dirty);
  await run("git", ["fetch", "--quiet", "--tags", "origin", "main"]);
  const [head, remote] = await Promise.all([run("git", ["rev-parse", "HEAD"]), run("git", ["rev-parse", "origin/main"])]);
  if (head.out !== remote.out) throw new StepError("Your main is not the same commit as origin/main.", "git pull --ff-only, then npm run release again.");
  const published = await registryVersion(pkg.name);
  const lastTag = (await run("git", ["describe", "--tags", "--abbrev=0", "--match", "v*"], { allowFail: true })).out || null;
  const range = lastTag ? `${lastTag}..HEAD` : "HEAD";
  const changes = (await run("git", ["log", "--first-parent", "--format=%s", "-n", "20", range])).out;
  return { repo, head: head.out, latest: published?.version ?? null, lastTag, changes: changes ? changes.split("\n") : [] };
}

async function waitForChecks(repo, pr, say) {
  // Right after a push GitHub may not have registered the checks yet.
  for (let i = 0; i < 30; i++) {
    const list = await run("gh", ["pr", "checks", pr, "-R", repo, "--json", "name"], { allowFail: true });
    if (list.code === 0 && list.out && list.out !== "[]") break;
    say(`waiting for CI to start on #${pr}`);
    await sleep(5000);
  }
  say(`CI is running on #${pr}`);
  const watched = await run("gh", ["pr", "checks", pr, "-R", repo, "--watch", "--fail-fast", "--interval", "10"], { allowFail: true });
  if (watched.code !== 0) {
    throw new StepError(`CI failed on #${pr}.`, `The pull request stays open: https://github.com/${repo}/pull/${pr}. Fix it there, or close it and delete its branch.`);
  }
}

async function findRun(repo, tag) {
  for (let i = 0; i < 30; i++) {
    const runs = JSON.parse((await run("gh", ["run", "list", "-R", repo, "--workflow", WORKFLOW, "--branch", tag, "--json", "databaseId,url", "--limit", "1"])).out || "[]");
    if (runs.length) return runs[0];
    await sleep(4000);
  }
  throw new StepError(`No ${WORKFLOW} run started for ${tag}.`, `Look at https://github.com/${repo}/actions/workflows/${WORKFLOW}.`);
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  const pkg = readPkg();
  const repo = repoFromPackage(pkg);

  p.intro(styleText("bgCyan", styleText("black", ` release ${pkg.name} `)) + (opts.dryRun ? dim("  dry run: nothing will change") : ""));

  let state;
  try {
    state = await step("Checking the checkout, gh and npm", () => preflight(pkg, repo), (s) => `main is clean and current at ${s.head.slice(0, 7)}`);
  } catch (e) {
    bail(e);
  }

  const current = pkg.version;
  // A version merged but never published (a publish run that failed, a tag never pushed) is
  // released as it is, without a second bump.
  const pending = state.latest && isNewer(current, state.latest);
  p.note(
    [
      `on npm      ${state.latest ? green(state.latest) : dim("not published yet")}`,
      `on main     ${pending ? styleText("yellow", `${current} (not on npm yet)`) : current}`,
      `last tag    ${state.lastTag ?? dim("none")}`,
      "",
      state.changes.length ? bold(`Merged since ${state.lastTag ?? "the start"}:`) : dim(`Nothing merged since ${state.lastTag}.`),
      ...state.changes.map((c) => `${dim("•")} ${c}`),
    ].join("\n"),
    repo,
  );

  let next;
  if (opts.target) {
    next = LEVELS.includes(opts.target) ? bump(current, opts.target) : opts.target;
  } else {
    const options = LEVELS.map((level) => ({ value: bump(current, level), label: level, hint: `${current} → ${bump(current, level)}` }));
    if (pending) options.unshift({ value: current, label: `publish ${current} as it is`, hint: "already on main, never published" });
    next = await ask(p.select({ message: "What kind of release?", options }));
  }
  if (next !== current && !isNewer(next, current)) bail(new StepError(`${next} is not above ${current}.`));
  if (next === current && !pending) bail(new StepError(`${current} is already on npm.`));
  const tag = `v${next}`;

  let card = opts.card;
  if (card == null && !opts.yes) {
    card = await ask(p.text({ message: "Linear card for the commit (optional)", placeholder: "REB-123", validate: (v) => (!v || /^REB-\d+$/.test(v.trim()) ? undefined : "A card id looks like REB-123") }));
  }
  card = card?.trim() || null;

  const plan = [
    next === current ? `${dim("1.")} no bump: ${current} is already on main` : `${dim("1.")} pull request: chore(release): ${next}${card ? `, ${card}` : ""}`,
    `${dim("2.")} wait for CI, merge with a merge commit`,
    `${dim("3.")} tag ${cyan(tag)} on main and push it`,
    `${dim("4.")} follow ${WORKFLOW}: tests, then npm publish with provenance`,
    `${dim("5.")} wait until npm serves ${next}`,
  ];
  p.note(plan.join("\n"), `Plan for ${bold(next)}`);

  if (opts.dryRun) {
    p.outro(dim("Dry run: nothing was changed."));
    return;
  }
  if (!opts.yes && !(await ask(p.confirm({ message: `Release ${bold(next)} to npm now?`, initialValue: false })))) {
    p.cancel("Nothing was changed.");
    return;
  }

  try {
    let prUrl = null;
    if (next !== current) {
      const branch = `release/${tag}`;
      prUrl = await step(`Opening the pull request for ${next}`, async (say) => {
        await run("git", ["switch", "--quiet", "-c", branch, "origin/main"]);
        await run("npm", ["version", next, "--no-git-tag-version"]);
        await run("git", ["add", "package.json", "package-lock.json"]);
        const message = ["commit", "--quiet", "-m", `chore(release): ${next}`];
        if (card) message.push("-m", `${card}.`);
        await run("git", message);
        say("pushing the branch");
        await run("git", ["push", "--quiet", "-u", "origin", branch]);
        const body = `Version ${next}, released with \`npm run release\`.${card ? `\n\nRelates to ${card}.` : ""}`;
        return (await run("gh", ["pr", "create", "-R", repo, "--base", "main", "--head", branch, "--title", `chore(release): ${next}`, "--body", body])).out.split("\n").pop();
      }, (url) => `Pull request ${cyan(url)}`);
      const pr = prUrl.split("/").pop();

      await step("Waiting for CI", (say) => waitForChecks(repo, pr, say), () => `CI is green on #${pr}`);

      await step(`Merging #${pr}`, async () => {
        await run("gh", ["pr", "merge", pr, "-R", repo, "--merge", "--delete-branch"]);
        await run("git", ["switch", "--quiet", "main"]);
        await run("git", ["pull", "--quiet", "--ff-only", "origin", "main"]);
        await run("git", ["branch", "-D", branch], { allowFail: true });
      }, () => `Merged #${pr} into main`);
    }

    await step(`Tagging ${tag}`, async () => {
      if (readPkg().version !== next) throw new StepError(`main's package.json says ${readPkg().version}, not ${next}.`);
      await run("git", ["tag", "-a", tag, "-m", tag]);
      await run("git", ["push", "--quiet", "origin", tag]);
    }, () => `Pushed ${cyan(tag)}`);

    const ghRun = await step(`Following ${WORKFLOW}`, async (say) => {
      const found = await findRun(repo, tag);
      say(`tests and publish: ${found.url}`);
      const watched = await run("gh", ["run", "watch", String(found.databaseId), "-R", repo, "--exit-status", "--interval", "10"], { allowFail: true });
      if (watched.code !== 0) throw new StepError(`${WORKFLOW} failed for ${tag}.`, `Nothing was published. Read ${found.url}; once fixed on main, run gh run rerun ${found.databaseId} -R ${repo}, or npm run release again to publish ${next} as it is.`);
      return found;
    }, () => `Published from GitHub Actions`);

    const meta = await step(`Waiting for npm to serve ${next}`, async (say) => {
      for (let i = 0; i < 60; i++) {
        const v = await registryVersion(pkg.name, next);
        if (v) return v;
        say(`waiting for npm to serve ${next} (it can take a few minutes)`);
        await sleep(10000);
      }
      throw new StepError(`npm does not serve ${next} yet after ten minutes.`, `The run succeeded (${ghRun.url}); check https://www.npmjs.com/package/${pkg.name} later.`);
    }, () => `npm serves ${next}`);

    const provenance = meta.dist?.attestations?.provenance ? green("yes") : styleText("yellow", "not found");
    p.note(
      [
        `npm         https://www.npmjs.com/package/${pkg.name}/v/${next}`,
        `provenance  ${provenance}`,
        `run         ${ghRun.url}`,
        ...(prUrl ? [`pr          ${prUrl}`] : []),
        `try it      npx ${pkg.name}@${next} --version`,
      ].join("\n"),
      `${pkg.name}@${next}`,
    );
    p.outro(green(`Released ${next}.`));
  } catch (e) {
    bail(e);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
