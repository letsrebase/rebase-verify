// The command a person types to run rebase-verify again, as they started it this time:
// npx puts nothing on the PATH and a clone has no `rebase-verify` either, so a hint that
// says `rebase-verify submit` fails for both.
import { basename, isAbsolute, relative } from "node:path";

export const PACKAGE_NAME = "@letsrebase/verify";

export function invocation({ env = process.env, script = process.argv[1] ?? "", cwd = process.cwd() } = {}) {
  // npm exec and npx both set npm_command=exec for the process they start.
  if (env.npm_command === "exec") return `npx ${PACKAGE_NAME}`;
  // An installed package runs through its bin link (or, on Windows, a shim that passes the
  // path inside node_modules): the `rebase-verify` command exists.
  if (basename(script) !== "rebase-verify.mjs" || /[\\/]node_modules[\\/]/.test(script)) return "rebase-verify";
  const rel = relative(cwd, script);
  const path = rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : script;
  return `node ${/\s/.test(path) ? `"${path}"` : path}`;
}
