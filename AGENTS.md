# AGENTS.md: working on rebase-verify

`letsrebase/rebase-verify` is rebase's fork of
[Play-New/apply-new](https://github.com/Play-New/apply-new), the MIT-licensed CLI by Play
New that turns a person's coding-agent logs into a private, redacted work profile. rebase
uses it so that freelancers can send that profile to the rebase hub, where a person (an
admin) reviews it before it counts. Read upstream's `README.md`, `CONTRIBUTING.md`,
`PRIVACY.md` and [`docs/adr/001-just-a-report.md`](docs/adr/001-just-a-report.md) before
changing anything. Their privacy rules hold here unchanged: never read `.env`, redaction
runs before anything else sees the logs, `repoLabel` never leaves the machine, custom MCP
servers, skills and commands surface as counts only, and nothing is sent before
`submit --yes`. Their no-ranking frame does not hold as is: see § Where we depart.

The repository and the tool were called `work-profile` until 2026-11-18, when they were renamed `rebase-verify` (REB-1140); GitHub redirects the old URL.

## Two kinds of change, and where each one goes

Every change is one of two kinds, decided before the branch exists.

- **Upstream-able**: anything that would make sense in `Play-New/apply-new` as it is (an
  adapter, a redaction fix, a metric correction, a test, a configurable recipient). It is
  written on a branch cut from `upstream/main`, opened as a pull request against
  `Play-New/apply-new` following its `CONTRIBUTING.md` (an issue first for any behaviour
  change), and merged into our `main` as well, either from upstream once they take it or
  from the same branch if we need it sooner. Upstream may reshape the change in review,
  so expect to resolve a conflict by hand on the next merge from `upstream/main`.
- **Fork-only**: what only rebase needs (the recipient, the hub token, the texts a
  freelancer reads before consenting, our privacy notice, this file). It is written on a
  branch cut from our `main` and never proposed upstream.

When in doubt, it is upstream-able: the rule is to give back everything that fits the
original.

## Remotes and syncing

```
git remote add upstream https://github.com/Play-New/apply-new
git fetch upstream
git checkout -b <upstream-branch> upstream/main   # an upstream-able change
git merge upstream/main                            # bring upstream into our main
```

`main` is published, so it takes upstream by merge and is never rebased or force-pushed.
Keep fork-only changes in as few files as possible, so that a merge from upstream stays
cheap.

## Where we depart from upstream

ADR-001 point 4 commits Play New's intake to never sorting, filtering or thresholding on a
profile field. rebase deliberately departs from it: an approved profile earns a badge and
an effect on search in the hub. The guard we keep instead is that nothing counts before a
person approves it, and that no model-written score about a person ships before Linear
REB-1132 is decided (`docs/design/DECISIONS.md` of `letsrebase/rebase`, 2026-11-17).

The texts a freelancer reads (`README.md`, `PRIVACY.md`, `SECURITY.md`,
`.claude/commands/rebase-verify.md`) and the links in `package.json` name rebase as the
recipient and point at `letsrebase/rebase-verify`. A change to what `submit` sends or keeps
changes those texts in the same commit, so that no freelancer is shown a promise of the
wrong recipient.

## What stays upstream's

- `LICENSE` keeps the original copyright notice, as the MIT licence requires.
- `CONTRIBUTING.md` is Play New's process for `Play-New/apply-new` and names its
  maintainers; this fork's maintainer is the one in `.github/CODEOWNERS`.
- `docs/adr/` records Play New's decisions. Our own decisions about this fork are rows in
  `docs/design/DECISIONS.md` of the `letsrebase/rebase` monorepo, not ADRs here.
- Upstream's CI (`.github/workflows/test.yml`, `npm test`, Node 20, 22 and 26 plus Windows)
  runs unchanged; every change keeps it green.

## Tracker and writing

The work is tracked in Linear, team `rebase` (prefix `REB-`), project «Let freelancers show
how they work with a reviewed work profile». A fork-only commit follows Conventional Commits
with the card as its last line (`REB-42.`); a commit on an upstream branch follows upstream's
own style (`area: what changed`) and carries no card id. Everything here is written in
English.
