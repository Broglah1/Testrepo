#!/usr/bin/env node
// planloop preToolUse deny hook — Copilot CLI, the Copilot coding agent sandbox, and VS Code agent
// sessions (the Copilot target, which uses Copilot CLI's hook runtime, and the Local agent, which
// maps this Copilot-format file but sends its own `{tool_name, tool_input}` payload).
//
// For every tool call that carries a shell command — Copilot's bash/powershell, VS Code's
// `run_in_terminal`, a VS Code task's `command` + `args`, or any tool whose input has a string
// `command` — it resolves every `git` / `gh` invocation in the command line and denies:
//   - `gh pr merge` (any global flags), `gh api` calls that hit a merge endpoint, `gh repo sync`;
//   - `git merge` / `git pull` while on main/master (or after switching to it in the same command);
//   - every `git push`, unless PLANLOOP_HEAD_BRANCH and PLANLOOP_PUSH_REMOTE are set — then only a
//     non-force push with exactly one explicit `<src>:refs/heads/<PLANLOOP_HEAD_BRANCH>` refspec to
//     that remote is permitted;
//   - any git/gh use it cannot resolve with certainty (aliases, `-c` overrides on push, wrappers such
//     as `bash -c` / `xargs` / `$(...)` around a sensitive verb).
// A deny prints exactly one JSON object carrying both output shapes: Copilot's top-level
// `permissionDecision` (+ `reason`), and VS Code Local's `hookSpecificOutput`. Anything else prints
// nothing (normal permission flow continues). A payload that cannot be parsed exits 2, which both
// Copilot and VS Code treat as a block. Dependency-free on purpose: a hook TIMEOUT is fail-open, so
// this must stay fast.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Copilot CLI's shell tools and VS Code's terminal tool. Any other tool is still checked when its input
// carries a shell command (see commandOf).
const SHELL_TOOLS = new Set(["bash", "powershell", "shell", "sh", "zsh", "pwsh", "cmd", "run_in_terminal"]);
const PROTECTED = new Set(["main", "master"]);

/** Split a command line into segments at unquoted control operators; tokens keep quotes resolved. */
export function splitSegments(command) {
  const segments = [];
  let tokens = [];
  let cur = "";
  let has = false;
  let quote = null;
  let opaque = false; // an unquoted $( … ), backtick, or process substitution was seen
  const push = () => {
    if (has) tokens.push(cur);
    cur = "";
    has = false;
  };
  const end = () => {
    push();
    if (tokens.length > 0 || opaque) segments.push({ tokens, opaque });
    tokens = [];
    opaque = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    const next = command[i + 1];
    if (quote) {
      if (c === quote) quote = null;
      else if (quote === '"' && c === "\\" && next !== undefined) {
        cur += next;
        i++;
      } else {
        if (quote === '"' && (c === "`" || (c === "$" && next === "("))) opaque = true;
        cur += c;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      has = true;
      continue;
    }
    if (c === "\\" && next !== undefined && next !== "\n") {
      cur += next;
      has = true;
      i++;
      continue;
    }
    if (c === "`" || (c === "$" && next === "(") || ((c === "<" || c === ">") && next === "(")) opaque = true;
    if (c === "&" || c === "|" || c === ";" || c === "\n" || c === "\r") {
      end();
      if ((c === "&" || c === "|") && next === c) i++;
      continue;
    }
    if (c === " " || c === "\t") {
      push();
      continue;
    }
    cur += c;
    has = true;
  }
  if (quote) return null; // unbalanced quoting: unresolvable
  end();
  return segments;
}

const WRAPPERS = new Set(["env", "command", "exec", "nohup", "time", "sudo", "&", "call", "start", "."]);

function programName(token) {
  const base = token.replaceAll("\\", "/").split("/").pop() ?? token;
  return base.toLowerCase().replace(/\.(exe|cmd|bat)$/, "");
}

/** The program and its arguments for a segment, skipping env assignments and plain wrappers. */
function invocation(tokens) {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      i++;
      continue;
    }
    if (WRAPPERS.has(t.toLowerCase())) {
      i++;
      while (i < tokens.length && tokens[i].startsWith("-")) i++;
      continue;
    }
    break;
  }
  if (i >= tokens.length) return null;
  return { program: programName(tokens[i]), args: tokens.slice(i + 1) };
}

// git global options that take a separate value argument.
const GIT_VALUE_OPTS = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env", "--super-prefix", "--list-cmds"]);

/** Resolve `git [global options] <sub> <args…>`. */
export function parseGit(args) {
  const globals = [];
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    const a = args[i];
    const eq = a.indexOf("=");
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (GIT_VALUE_OPTS.has(name) && eq < 0) {
      globals.push({ name, value: args[i + 1] ?? "" });
      i += 2;
    } else {
      globals.push({ name, value: eq > 0 ? a.slice(eq + 1) : "" });
      i++;
    }
  }
  return { globals, sub: args[i] ?? null, rest: args.slice(i + 1) };
}

const GIT_BUILTINS = new Set(
  (
    "add am annotate apply archive bisect blame branch bundle cat-file check-attr check-ignore checkout checkout-index cherry cherry-pick citool clean clone commit commit-tree config count-objects describe diff diff-files diff-index diff-tree difftool fetch for-each-ref format-patch fsck gc grep hash-object help init log ls-files ls-remote ls-tree merge merge-base mv notes pull push range-diff rebase reflog remote repack replace reset restore rev-list rev-parse revert rm shortlog show show-ref sparse-checkout stash status submodule switch symbolic-ref tag update-index update-ref var verify-commit version whatchanged worktree write-tree maintenance"
  ).split(" "),
);

function deny(reason) {
  return {
    permissionDecision: "deny",
    permissionDecisionReason: reason,
    reason,
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
  };
}

/**
 * The shell command a tool call would run, or null when it runs none: `command` for shell and
 * terminal tools (and any tool whose input has a string `command`), and `task.command` + `task.args`
 * for VS Code's `create_and_run_task`.
 */
export function commandOf(toolName, toolArgs) {
  if (typeof toolArgs?.command === "string") return toolArgs.command;
  const task = toolArgs?.task;
  if (task && typeof task.command === "string") {
    const args = Array.isArray(task.args) ? task.args.filter((a) => typeof a === "string") : [];
    return [task.command, ...args].join(" ");
  }
  return SHELL_TOOLS.has(String(toolName).toLowerCase()) ? "" : null;
}

/** Evaluate one git push against the explicit-head rule. Returns a deny or null (permitted). */
export function checkPush(globals, rest, env) {
  const head = env.PLANLOOP_HEAD_BRANCH;
  const remote = env.PLANLOOP_PUSH_REMOTE;
  if (!head) return deny("planloop: git push is denied (no PR head branch is configured for this turn).");
  if (!remote) return deny("planloop: git push is denied (no verified push remote is configured for this turn).");
  const unsupportedGlobal = globals.find((g) => g.name !== "--no-pager" && g.name !== "-P");
  if (unsupportedGlobal) {
    return deny(`planloop: git push with global option ${unsupportedGlobal.name} is not resolvable; push denied.`);
  }
  const positional = [];
  for (const a of rest) {
    if (a === "--") continue;
    if (a.startsWith("-")) {
      if (["-u", "--set-upstream", "-q", "--quiet", "-v", "--verbose", "--porcelain", "--no-verify", "--atomic", "--progress", "--no-progress"].includes(a)) continue;
      if (a === "-f" || a.startsWith("--force") || a === "--mirror" || a === "--all" || a === "--branches" || a === "--tags" || a === "--follow-tags" || a === "-d" || a === "--delete" || a === "--prune") {
        return deny(`planloop: git push ${a} is denied.`);
      }
      if (/^-[a-zA-Z]{2,}$/.test(a) && a.includes("f")) return deny("planloop: force push is denied.");
      return deny(`planloop: git push option ${a} is not permitted.`);
    }
    positional.push(a);
  }
  if (positional.length !== 2) {
    return deny(`planloop: git push must name the remote and exactly one explicit refspec ending in refs/heads/${head}.`);
  }
  const [target, refspec] = positional;
  if (target !== remote) return deny(`planloop: git push to "${target}" is denied; only "${remote}" is permitted.`);
  if (refspec.startsWith("+")) return deny("planloop: force refspec (+) is denied.");
  const colon = refspec.indexOf(":");
  if (colon <= 0) return deny("planloop: implicit or deleting refspec is denied; use <src>:refs/heads/<head>.");
  const src = refspec.slice(0, colon);
  const dst = refspec.slice(colon + 1);
  if (src.includes("*") || dst.includes("*")) return deny("planloop: wildcard refspecs are denied.");
  if (dst !== `refs/heads/${head}`) return deny(`planloop: git push may only update refs/heads/${head}.`);
  return null;
}

function defaultGit(cwd) {
  return (args) => {
    try {
      return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).trim();
    } catch {
      return null;
    }
  };
}

/**
 * Evaluate a tool call. `git(args)` runs a read-only git query in the session cwd (stdout or null).
 * Returns a deny object, or null when the call may proceed.
 */
export function evaluate(toolName, toolArgs, env, git) {
  const command = commandOf(toolName, toolArgs);
  if (command === null || command === "") return null;
  const segments = splitSegments(command);
  if (segments === null) {
    return /\b(git|gh)\b/.test(command) ? deny("planloop: unbalanced quoting around a git/gh command; denied.") : null;
  }
  let branch; // resolved lazily
  const currentBranch = () => {
    if (branch === undefined) branch = git(["rev-parse", "--abbrev-ref", "HEAD"]) ?? "";
    return branch;
  };
  let switchedToProtected = false;
  for (const { tokens, opaque } of segments) {
    const text = tokens.join(" ");
    const inv = invocation(tokens);
    const prog = inv?.program ?? "";
    if (prog === "git") {
      const { globals, sub, rest } = parseGit(inv.args);
      if (opaque) return deny("planloop: git with command substitution is not resolvable; denied.");
      const alias = globals.find((g) => g.name === "-c" && /^alias\./i.test(g.value));
      if (alias) return deny("planloop: git -c alias.* is denied.");
      if (sub === null) continue;
      if (!GIT_BUILTINS.has(sub)) {
        if (git(["config", "--get", `alias.${sub}`]) !== null) return deny(`planloop: git alias "${sub}" is not resolvable; denied.`);
        continue;
      }
      if ((sub === "switch" || sub === "checkout") && rest.some((a) => PROTECTED.has(a))) switchedToProtected = true;
      if (sub === "merge" || sub === "pull") {
        // `git pull origin main` on a feature branch merges main INTO it: allowed. Only landing on
        // main/master is denied.
        if (switchedToProtected || PROTECTED.has(currentBranch())) return deny(`planloop: git ${sub} into main/master is denied.`);
      }
      if (sub === "push") {
        const verdict = checkPush(globals, rest, env);
        if (verdict) return verdict;
      }
      continue;
    }
    if (prog === "gh") {
      const args = inv.args;
      let i = 0;
      while (i < args.length && args[i].startsWith("-")) i += args[i].includes("=") ? 1 : 2;
      const [group, action] = [args[i], args[i + 1]];
      if (opaque && /\b(merge|api|sync)\b/.test(text)) return deny("planloop: gh with command substitution is not resolvable; denied.");
      if (group === "pr" && action === "merge") return deny("planloop: gh pr merge is denied — merging is the human's action.");
      if (group === "repo" && action === "sync") return deny("planloop: gh repo sync is denied.");
      if (group === "api" && /pulls\/\d+\/merge|\/merges\b|mergePullRequest|enablePullRequestAutoMerge|mergeBranch/i.test(args.join(" "))) {
        return deny("planloop: gh api merge endpoints are denied.");
      }
      continue;
    }
    // Not directly git/gh, but mentions a sensitive git/gh verb (bash -c "…", xargs git push, iex …).
    if (/\bgit(\.exe)?\b[\s\S]*\b(push|merge|pull)\b/i.test(text) || /\bgh(\.exe)?\b[\s\S]*\b(merge|api|sync)\b/i.test(text)) {
      return deny("planloop: a git/gh command wrapped in another program is not resolvable; denied.");
    }
  }
  return null;
}

/**
 * Tools known to send raw, non-JSON text as their whole input, none of which runs a shell command:
 * Copilot's `apply_patch` (the edit tool GPT models use) sends the patch itself.
 */
const RAW_TEXT_TOOLS = new Set(["apply_patch"]);

/**
 * Parse a hook payload (camelCase). `toolArgs` must be a JSON object, given directly or as a JSON
 * string; anything else — unparseable text, or JSON that is not an object, such as a bare string that
 * could hold a command — throws (exit 2, a deny), because the command could not be read. RAW_TEXT_TOOLS
 * are the exception: their raw input is checked like any other input without a shell command.
 */
export function parsePayload(raw) {
  const payload = JSON.parse(raw);
  if (typeof payload !== "object" || payload === null) throw new Error("payload is not an object");
  const toolName = payload.toolName ?? payload.tool_name;
  if (typeof toolName !== "string") throw new Error("payload has no toolName");
  const given = payload.toolArgs ?? payload.tool_input ?? {};
  let toolArgs = given;
  if (typeof toolArgs === "string") {
    try {
      toolArgs = JSON.parse(toolArgs);
    } catch {
      // Not JSON: only a RAW_TEXT_TOOLS input survives the object check below.
    }
  }
  if (typeof toolArgs !== "object" || toolArgs === null || Array.isArray(toolArgs)) {
    if (!RAW_TEXT_TOOLS.has(toolName.toLowerCase())) throw new Error("tool input is not a JSON object");
    toolArgs = { input: given };
  }
  return { toolName, toolArgs, cwd: typeof payload.cwd === "string" ? payload.cwd : process.cwd() };
}

function main() {
  let parsed;
  try {
    parsed = parsePayload(readFileSync(0, "utf8"));
  } catch (err) {
    process.stderr.write(`planloop-deny: unreadable hook payload (${err instanceof Error ? err.message : String(err)})\n`);
    process.exit(2);
  }
  const verdict = evaluate(parsed.toolName, parsed.toolArgs, process.env, defaultGit(parsed.cwd));
  if (verdict) process.stdout.write(`${JSON.stringify(verdict)}\n`);
}

function isEntryPoint() {
  if (!process.argv[1]) return false;
  const norm = (p) => resolve(p).toLowerCase();
  return norm(fileURLToPath(import.meta.url)) === norm(process.argv[1]);
}

if (isEntryPoint()) main();
