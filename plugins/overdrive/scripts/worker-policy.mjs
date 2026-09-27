import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_SCRIPT = fileURLToPath(new URL('./server.mjs', import.meta.url));
const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url));

// The agent kinds that may call each tool of the worker-mode server.
export const WORKER_TOOLS = Object.freeze({
  message_send: ['feature', 'qa'],
  lanes: ['feature', 'qa'],
  lab_get: ['feature', 'qa'],
  lab_run: ['feature', 'qa'],
  finding_record: ['qa'],
  integration_build: ['qa'],
});

// MCP server names that give browser or computer control; cua_repl is Codex's computer-use engine.
export const BROWSER_CONTROL = /chrome|browser|computer|playwright|puppeteer|cua_repl/i;

// Deliberately broad: any options between git and push (or subtree push), a quoted git.exe path, and
// gh api calls with a writing method all count as publishing.
const GIT_PUSH = String.raw`git(?:\.exe)?["']?(?:\s+-\S*(?:\s+(?:"[^"]*"|'[^']*'|\S+))?)*\s+(?:subtree\s+)?push`;
const GH_API_WRITE = String.raw`gh\s+api\b[^\n;&|]*\s(?:-X|--method)[\s=]*(?:POST|PATCH|PUT|DELETE)`;
// The gh pr and gh issue subcommands that change GitHub; reads such as view, list, diff and checks stay allowed.
export const GH_PR_WRITES = Object.freeze(['create', 'merge', 'edit', 'comment', 'review', 'close', 'reopen', 'ready', 'lock', 'unlock', 'revert', 'update-branch']);
const GH_ISSUE_WRITES = ['create', 'edit', 'comment', 'close', 'reopen', 'lock', 'unlock', 'delete', 'transfer', 'pin', 'unpin', 'develop'];
const GH_WRITE = String.raw`gh\s+(?:pr\s+(?:${GH_PR_WRITES.join('|')})|issue\s+(?:${GH_ISSUE_WRITES.join('|')})|release|repo\s+create)`;
const PUBLISH_COMMAND = new RegExp(String.raw`\b(?:${GIT_PUSH}|${GH_WRITE}|${GH_API_WRITE}|(?:npm|pnpm|cargo)\s+publish|yarn\s+(?:npm\s+)?publish|dotnet\s+nuget\s+push|twine\s+upload|docker\s+push)\b`, 'i');
const ALLOW = Object.freeze({ allow: true });
const deny = message => ({ allow: false, message });
// Tools whose input names every file they write: Claude's file tools, and a Codex patch as the app-server passes it.
const FILE_WRITES = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'apply_patch']);

// Windows paths compare case-insensitively, and a Git Bash path such as /c/repo names drive C:.
function comparablePath(value) {
  if (process.platform !== 'win32') return path.resolve(value);
  return path.resolve(value.replace(/^\/([a-z])(?=\/|$)/i, '$1:')).toLowerCase();
}

function inside(target, root) {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// The OS temp directory by its given and its real path, which differ on macOS (/var is /private/var).
function tempDirectories() {
  try { return [os.tmpdir(), fs.realpathSync.native(os.tmpdir())]; } catch { return [os.tmpdir()]; }
}

// A file tool may write only inside the agent's write roots, or in the OS temp directory outside the workspace and this
// plugin, either of which can lie inside it, and never in a .git directory.
function writesOutsideRoots(input, writeRoots, workspaceRoot) {
  const targets = [input?.file_path, input?.notebook_path, ...(Array.isArray(input?.file_paths) ? input.file_paths : [])].filter(value => value !== undefined);
  if (!targets.length || targets.some(value => typeof value !== 'string' || !value)) return true;
  const within = (target, roots) => roots.some(root => inside(target, comparablePath(root)));
  const allowed = target => within(target, writeRoots) || (within(target, tempDirectories()) && !within(target, [workspaceRoot, PLUGIN_ROOT].filter(Boolean)));
  return targets.map(comparablePath).some(target => target.split(path.sep).includes('.git') || !allowed(target));
}

// Git configuration outside the repository is the user's (a worker once renamed the user's global identity); reads stay allowed.
function writesUserGitConfig(input) {
  if (typeof input?.command !== 'string') return false;
  return input.command.split(/[;&|\n]/).some(part => /\bgit\b.*\bconfig\b/i.test(part)
    && /\s--(?:global|system)\b/i.test(part)
    && !/\s(?:--get(?:-all|-regexp)?|--list|-l|get|list)\b/i.test(part));
}

// A lane row's capability profile; anything but an explicit QA agent gets the restricted profile.
export const workerProfile = row => (row.kind === 'qa' ? 'qa' : 'feature');

// The worker-mode OVERDRIVE server injected into an agent's harness, bound to that agent.
export function workerServer(root, slug) {
  return { command: process.execPath, args: [SERVER_SCRIPT], env: { OVERDRIVE_AGENT: slug, OVERDRIVE_WORKSPACE: root } };
}

// The one permission policy both worker harnesses apply to tool calls. writeRoots are the directories the
// agent's file tools may write in, and workspaceRoot the OVERDRIVE workspace; safetyCheck marks a call Claude
// Code flagged as touching a protected path or running a destructive command, which only a file write the
// path rule vetted may pass.
export function workerToolDecision(profile, toolName, input, { writeRoots = null, workspaceRoot = null, safetyCheck = false } = {}) {
  const name = String(toolName ?? '');
  const server = /^mcp__(.+?)__/.exec(name)?.[1];
  if (server && (/^plugin_(?:overdrive|feature-theater)_/.test(server) || server === 'feature_theater' || (server === 'overdrive' && !Object.hasOwn(WORKER_TOOLS, name.slice('mcp__overdrive__'.length))))) {
    return deny('OVERDRIVE coordinator tools are not available to workers; reach the coordinator with message_send.');
  }
  if (profile !== 'qa' && server && BROWSER_CONTROL.test(server)) return deny('Browser and computer control belong to QA; ask qa with message_send to verify it.');
  if (typeof input?.command === 'string' && PUBLISH_COMMAND.test(input.command)) return deny("Publishing needs the user's authority; ask the coordinator.");
  if (writesUserGitConfig(input)) return deny('Global and system Git configuration belongs to the user; use repository-local git config instead.');
  const vetsPaths = writeRoots && FILE_WRITES.has(name);
  if (vetsPaths && writesOutsideRoots(input, writeRoots, workspaceRoot)) {
    return deny(`File tools may write only under ${writeRoots.join(', ')} or the temp directory, and never inside .git; ask the agent that owns the path with message_send.`);
  }
  if (safetyCheck && !vetsPaths) return deny('Claude Code flagged this call as touching a protected path or running a destructive command; ask the coordinator with message_send.');
  return ALLOW;
}

export function denialNote(tools) {
  return `Worker permission policy denied ${tools.length} tool call(s): ${[...new Set(tools)].join(', ')}. Send browser or testing needs to QA with message_send; publishing needs the user's authority through the coordinator; file tools write only in the agent's own checkout, or for QA the lab and the integration clone.`;
}
