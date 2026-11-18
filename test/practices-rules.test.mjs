import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isTestPath, isSourcePath, isDesignDocPath, isPlanPath,
  isCheckCommand, isSecurityCommand, isDiffCommand, isCommitCommand,
} from "../src/practices-rules.mjs";

test("isTestPath", () => {
  for (const p of ["test/a.mjs", "src/__tests__/a.ts", "spec/x.rb", "a.test.ts", "a.spec.js", "foo_test.go", "pkg/test_x.py", "C:\\proj\\tests\\a.ts"]) assert.equal(isTestPath(p), true, p);
  for (const p of ["src/testing-utils.ts", "contest.py", "src/a.ts"]) assert.equal(isTestPath(p), false, p);
});
test("isSourcePath: code extension, not test, doc or config", () => {
  assert.equal(isSourcePath("src/a.ts"), true);
  assert.equal(isSourcePath("src/a.test.ts"), false);
  assert.equal(isSourcePath("README.md"), false);
  assert.equal(isSourcePath("package.json"), false);
  assert.equal(isSourcePath("⟨user⟩\\proj\\src\\a.py"), true);
});
test("design and plan paths", () => {
  for (const p of ["docs/adr/0001-x.md", "a/rfcs/1.md", "x/specs/y.md", "docs/design/z.md", "ADR-003.md", "foo-adr.md", "RFC12.md", "a-design.md", "a-spec.md", "DESIGN.md"]) assert.equal(isDesignDocPath(p), true, p);
  for (const p of ["docs/plans/a.md", "PLAN.md", "a-plan.md", "plan.md", "docs/specs/s.md"]) assert.equal(isPlanPath(p), true, p);
  assert.equal(isDesignDocPath("src/design.ts"), false);
  assert.equal(isPlanPath("src/plant.ts"), false);
});
test("check vocabulary covers every ecosystem the stack detection knows", () => {
  for (const c of ["pytest -q", "uv run pytest", "python -m pytest", "ruff check .", "mypy src", "go test ./...", "go vet ./...", "cargo test", "cargo clippy", "mvn test", "gradle test", "./gradlew test", "dotnet test", "phpunit", "rspec", "tsc --noEmit", "npx eslint .", "vitest run", "jest", "playwright test", "npm run build", "pnpm build"]) assert.equal(isCheckCommand(c), true, c);
  for (const c of ["cat pytest-notes.md", "echo jest", "git status", "ls tests"]) assert.equal(isCheckCommand(c), false, c);
});
test("security, diff and commit commands", () => {
  for (const c of ["npm audit", "pip-audit", "trivy fs .", "semgrep --config auto", "gitleaks detect", "govulncheck ./..."]) assert.equal(isSecurityCommand(c), true, c);
  for (const c of ["git diff", "git diff --staged", "git show HEAD", "gh pr diff 12"]) assert.equal(isDiffCommand(c), true, c);
  assert.equal(isCommitCommand("git add . && git commit -m 'x'"), true);
  assert.equal(isCommitCommand("echo git commit"), false);
});
