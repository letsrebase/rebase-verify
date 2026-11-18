// Rules behind the code-counted work practices of `rebase-practices/v1`: which
// paths are tests, sources, design documents or plans, and which shell commands
// are checks, security scans, diff displays or commits. share/practices.json
// publishes the same patterns (`npm run practices`), because a freelancer
// consents to them; test/practices-artifact.test.mjs keeps both in step.
import { splitTopLevel } from "./digest.mjs";

export const RUBRIC = "rebase-practices/v1";

// ---- Paths (every path treats `\` as `/`, case-insensitive) ----

export const TEST_PATH_PATTERNS = [
  { id: "test-dir", re: /(?:^|\/)(?:tests?|__tests__|spec)\// },
  { id: "test-file", re: /\.(?:test|spec)\.[^/]+$/ },
  { id: "go-style-test", re: /_test\.[^/]+$/ },
  { id: "python-test", re: /(?:^|\/)test_[^/]*\.py$/ },
];

const SOURCE_EXT = [
  "js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "vue", "svelte", "py", "go", "rs", "java", "kt",
  "kts", "scala", "rb", "php", "cs", "c", "cc", "cpp", "h", "hpp", "swift", "m", "dart", "ex", "exs", "lua",
];
export const SOURCE_PATH_PATTERNS = [{ id: "code-extension", re: new RegExp(`\\.(?:${SOURCE_EXT.join("|")})$`) }];

export const DESIGN_PATH_PATTERNS = [
  { id: "adr-dir", re: /(?:^|\/)adr\// },
  { id: "rfc-dir", re: /(?:^|\/)(?:rfcs\/|docs\/rfc\/)/ },
  { id: "design-dir", re: /(?:^|\/)docs\/design\// },
  { id: "specs-dir", re: /(?:^|\/)specs\// },
  { id: "adr-file", re: /(?:^|\/)(?:adr-[^/]*|[^/]*-adr\.md)$/ },
  { id: "rfc-file", re: /(?:^|\/)rfc[^/]*$/ },
  { id: "design-file", re: /(?:^|\/)(?:[^/]*-design|design)\.md$/ },
  { id: "spec-file", re: /(?:^|\/)[^/]*-spec\.md$/ },
];

// A spec file counts as a plan too.
export const PLAN_PATH_PATTERNS = [
  { id: "plans-dir", re: /(?:^|\/)plans\// },
  { id: "plan-file", re: /(?:^|\/)(?:[^/]*-plan|plan)\.md$/ },
  { id: "specs-dir", re: /(?:^|\/)specs\// },
  { id: "spec-file", re: /(?:^|\/)[^/]*-spec\.md$/ },
];

const norm = (p) => String(p ?? "").replace(/\\/g, "/").toLowerCase();
const anyMatch = (patterns, s) => patterns.some(({ re }) => re.test(s));

export const isTestPath = (path) => anyMatch(TEST_PATH_PATTERNS, norm(path));
export const isSourcePath = (path) => {
  const p = norm(path);
  return anyMatch(SOURCE_PATH_PATTERNS, p) && !isTestPath(p);
};
export const isDesignDocPath = (path) => anyMatch(DESIGN_PATH_PATTERNS, norm(path));
export const isPlanPath = (path) => anyMatch(PLAN_PATH_PATTERNS, norm(path));

// ---- Commands ----

const ENV_ASSIGN = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"(?:[^"\\]|\\.)*"|'[^']*'|\\.|[^\s"'\\])*\s+)+/;
const WRAPPER = /^(?:npx(?:\s+(?:-[-\w]+|--))*|bunx|pnpm\s+(?:exec|dlx)|npm\s+exec(?:\s+--)?|uv\s+run|poetry\s+run|pipenv\s+run|python3?\s+-m|py\s+-m)\s+/;

// The executable position of each top-level sub-command: openers, control-flow
// keywords, env assignments and runner prefixes (npx, uv run, python -m,
// pnpm exec) are transparent; arguments never match.
function executables(cmd) {
  const out = [];
  for (const raw of splitTopLevel(String(cmd ?? ""))) {
    let part = raw.trim().replace(/^[({\s]+/, "").replace(/^(?:do|then|else)\s+/, "").replace(ENV_ASSIGN, "");
    for (let i = 0; i < 3 && WRAPPER.test(part); i++) part = part.replace(WRAPPER, "");
    if (part) out.push(part);
  }
  return out;
}
const anyCommand = (patterns, cmd) => executables(cmd).some((e) => patterns.some(({ re }) => re.test(e)));

const END = String.raw`(?=\s|$)`;
const GIT = String.raw`git(?:\s+(?:-C\s+\S+|-c\s+\S+|--no-pager))*`;
const SCRIPT = String.raw`(?:run\s+)?(?:test|tests|lint|typecheck|type-check|check|build|ci)`;

export const CHECK_PATTERNS = [
  { id: "pytest", re: new RegExp(String.raw`^(?:py\.test|pytest)${END}`) },
  { id: "ruff", re: new RegExp(String.raw`^ruff\s+check${END}`) },
  { id: "mypy", re: new RegExp(String.raw`^(?:mypy|pyright|flake8|pylint)${END}`) },
  { id: "go-test", re: new RegExp(String.raw`^go\s+(?:test|vet)${END}`) },
  { id: "golangci-lint", re: new RegExp(String.raw`^golangci-lint\s+run${END}`) },
  { id: "cargo", re: new RegExp(String.raw`^cargo\s+(?:test|clippy|check|build|nextest)${END}`) },
  { id: "maven", re: new RegExp(String.raw`^(?:mvn|\./mvnw)\s+(?:\S+\s+)*?(?:test|verify|package)${END}`) },
  { id: "gradle", re: new RegExp(String.raw`^(?:gradle|\./gradlew)\s+(?:\S+\s+)*?(?:test|check|build)${END}`) },
  { id: "dotnet", re: new RegExp(String.raw`^dotnet\s+(?:test|build)${END}`) },
  { id: "phpunit", re: new RegExp(String.raw`^(?:\./)?(?:vendor/bin/)?(?:phpunit|phpstan|pest)${END}`) },
  { id: "rspec", re: new RegExp(String.raw`^(?:bundle\s+exec\s+)?(?:rspec|rubocop)${END}`) },
  { id: "tsc", re: new RegExp(String.raw`^tsc${END}`) },
  { id: "eslint", re: new RegExp(String.raw`^(?:eslint|biome\s+(?:check|lint|ci))${END}`) },
  { id: "vitest", re: new RegExp(String.raw`^vitest${END}`) },
  { id: "jest", re: new RegExp(String.raw`^jest${END}`) },
  { id: "playwright", re: new RegExp(String.raw`^(?:playwright|cypress)\s+(?:test|run)${END}`) },
  { id: "node-test", re: new RegExp(String.raw`^node\s+(?:\S+\s+)*?--test${END}`) },
  { id: "package-script", re: new RegExp(String.raw`^(?:npm|pnpm|yarn|bun)\s+${SCRIPT}${END}`) },
  { id: "make", re: new RegExp(String.raw`^make\s+(?:test|tests|check|lint|build|ci)${END}`) },
];

export const SECURITY_PATTERNS = [
  { id: "package-audit", re: new RegExp(String.raw`^(?:npm|pnpm|yarn|bun)\s+audit${END}`) },
  { id: "pip-audit", re: new RegExp(String.raw`^(?:pip-audit|safety\s+check|bandit)${END}`) },
  { id: "cargo-audit", re: new RegExp(String.raw`^cargo\s+(?:audit|deny)${END}`) },
  { id: "scanner", re: new RegExp(String.raw`^(?:trivy|semgrep|gitleaks|trufflehog|snyk|grype|osv-scanner|brakeman|bundler-audit|govulncheck)${END}`) },
];

export const DIFF_PATTERNS = [
  { id: "git-diff", re: new RegExp(String.raw`^${GIT}\s+(?:diff|show)${END}`) },
  { id: "gh-pr-diff", re: new RegExp(String.raw`^gh\s+pr\s+diff${END}`) },
];

const COMMIT_PATTERNS = [{ id: "git-commit", re: new RegExp(String.raw`^${GIT}\s+commit${END}`) }];

export const isCheckCommand = (cmd) => anyCommand(CHECK_PATTERNS, cmd);
export const isSecurityCommand = (cmd) => anyCommand(SECURITY_PATTERNS, cmd);
export const isDiffCommand = (cmd) => anyCommand(DIFF_PATTERNS, cmd);
export const isCommitCommand = (cmd) => anyCommand(COMMIT_PATTERNS, cmd);

// ---- The list ----

const CMD = "toolUses.cmd";
const PATH = "toolUses.path";
const ERR = "toolResults.isError";

export const CODE_PRACTICES = [
  {
    id: "checks_before_commit",
    method: "code",
    definition: "After the last file edit before a git commit, a check ran in the session: tests, a linter, a type check or a build.",
    denominator: "Sessions with a commit.",
    needs: [CMD, PATH],
  },
  {
    id: "tests_with_changes",
    method: "code",
    definition: "Both a source file and a test file were edited in the session.",
    denominator: "Sessions that edited a source file.",
    needs: [PATH],
  },
  {
    id: "failure_reproduced_before_fix",
    method: "code",
    definition: "A command failed, files were edited, and then the same command succeeded in the session.",
    denominator: "Sessions where a command failed.",
    needs: [CMD, PATH, ERR],
  },
  {
    id: "plan_before_edit",
    method: "code",
    definition: "A planning step came before the first file edit in the session: plan mode, a task list, or writing a plan or spec file.",
    denominator: "Sessions with an edit.",
    needs: [CMD, PATH],
  },
  {
    id: "reviews_changes",
    method: "code",
    definition:
      "Before a commit or a pull request, the diff appeared in the session (git diff, git show or gh pr diff), whoever asked for it; the session cannot show whether anyone read it.",
    denominator: "Sessions with a commit or a pull request.",
    needs: [CMD],
  },
  {
    id: "design_documents",
    method: "code",
    definition: "A design document (an ADR, RFC, spec or design file, by path) was written or edited in the session.",
    denominator: "Sessions with an edit.",
    needs: [PATH],
  },
  {
    id: "security_checks",
    method: "code",
    definition: "A dependency audit or a security scanner ran in the session.",
    denominator: "Sessions with an edit.",
    needs: [CMD, PATH],
  },
];

// Adapters whose logs cannot show a practice are left out of its denominator,
// never counted as "not seen". Cursor reads an absent failure flag as success.
export const ADAPTERS_WITHOUT = { failure_reproduced_before_fix: ["pi", "cursor"] };

const sources = (patterns) => patterns.map(({ re }) => re.source);

export function practicesArtifact() {
  return {
    rubric: RUBRIC,
    practices: CODE_PRACTICES.map(({ id, method, definition, denominator }) => ({ id, method, definition, denominator })),
    rules: {
      testPaths: sources(TEST_PATH_PATTERNS),
      designPaths: sources(DESIGN_PATH_PATTERNS),
      planPaths: sources(PLAN_PATH_PATTERNS),
      checks: sources(CHECK_PATTERNS),
      security: sources(SECURITY_PATTERNS),
      diff: sources(DIFF_PATTERNS),
    },
  };
}
