import { createHash, randomUUID } from 'node:crypto';
import { AGENT_BUSY_SQL, DESCENDANTS_CLEAR_SQL, WORKERS_CLEAR_SQL, descendantsKey, ownsAgent, recoverAgentState, unconfirmedDescendants, workersKey } from './ownership.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { codexExecutable } from './app-server.mjs';
import { claudeExecutable, normalizeWorkerOptions } from './claude-worker.mjs';
import { workerProfile } from './worker-policy.mjs';
import {
  OverdriveError,
  atomicWrite,
  contained,
  ensureManagedPath,
  exists,
  lineDiff,
  newAgentSlug,
  normalizeRepositorySource,
  now,
  optionalText,
  redactString,
  requiredText,
  resolveWorkspace,
  run,
  safeSlug,
  withWorkspaceLock,
  writeJson, STATE_DIR, CONFIG_FILE,
} from './util.mjs';
import {
  committedChanges,
  createFeatureCheckout,
  ensureCommitIdentity,
  initializeMirror,
  initializeRepository,
  inspectMirror,
  integrationPath,
  labPath,
  mirrorPath,
  profileRepository,
  readCommitIdentity,
  refreshMirror,
  repositorySnapshot,
  resolveMirrorRevision,
  verifyCheckoutRevision,
} from './git.mjs';
import {
  assertBoundCheckout,
  featureBySlug,
  initializeDatabase,
  listFeatureRows,
  loadWorkspace,
  meta,
  newId,
  parseJson,
  readFeatureRow,
  readWorkspaceConfig,
  recordEvent,
  transaction,
  workItems,
} from './state.mjs';
import { agentUsage, endTurnUsage, recordTurnUsage, startTurnUsage, workerSpend } from './usage.mjs';

const FEATURE_STATUSES = new Set(['planned', 'active', 'paused', 'blocked', 'review', 'done', 'archived']);
const WORK_STATUSES = new Set(['planned', 'ready', 'running', 'blocked', 'review', 'done', 'failed', 'cancelled']);
const WORK_KINDS = new Set(['scope', 'design', 'build', 'review', 'validate', 'repair', 'integrate']);

function closeContext(ctx) {
  try { ctx.db.close(); } catch { /* already closed */ }
}

export async function withContext(workspacePath, fn) {
  const root = await resolveWorkspace(workspacePath);
  const ctx = await loadWorkspace(root);
  try { return await fn(ctx); } finally { closeContext(ctx); }
}

function progressFor(db, featureId) {
  const counts = Object.fromEntries([...WORK_STATUSES].map(status => [status, 0]));
  for (const row of db.prepare('SELECT status, COUNT(*) AS count FROM work_items WHERE feature_id = ? GROUP BY status').all(featureId)) {
    counts[row.status] = Number(row.count);
  }
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  return {
    total,
    done: counts.done,
    running: counts.running,
    ready: counts.ready,
    blocked: counts.blocked,
    failed: counts.failed,
    open: total - counts.done - counts.cancelled,
  };
}

function latestSpec(db, featureId) {
  return db.prepare('SELECT revision, content, rationale, created_at FROM spec_revisions WHERE feature_id = ? ORDER BY revision DESC LIMIT 1').get(featureId);
}

function evidenceRows(db, featureId, limit = 50) {
  return db.prepare('SELECT * FROM evidence WHERE feature_id = ? ORDER BY created_at DESC LIMIT ?').all(featureId, limit)
    .map(({ output: _output, ...row }) => ({ ...row, passed: row.passed === null ? null : Boolean(row.passed) }));
}

function pendingRows(db, featureId) {
  return db.prepare("SELECT request_id, method, summary, payload_json, created_at FROM pending_agent_requests WHERE feature_id = ? AND status = 'pending' ORDER BY created_at").all(featureId)
    .map(row => ({ ...row, payload: parseJson(row.payload_json, {}) }))
    .map(({ payload_json: _payload, ...row }) => row);
}

function markdownCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replace(/\s+/g, ' ').trim();
}

async function ensureWorkspaceFiles(root, config) {
  const ignoreFile = contained(root, '.gitignore');
  const required = [
    'features/',
    '.overdrive/cache/',
    '.overdrive/locks/',
    '.overdrive/state.sqlite3*',
    '.overdrive/events.ndjson',
    'overdrive.json',
    'lab/',
    ...(config?.managedProject ? ['project/'] : []),
  ];
  let ignore = '';
  try { ignore = await fs.readFile(ignoreFile, 'utf8'); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const missing = required.filter(line => !ignore.split(/\r?\n/).includes(line));
  if (missing.length) {
    const prefix = ignore && !ignore.endsWith('\n') ? '\n' : '';
    await atomicWrite(root, ignoreFile, `${ignore}${prefix}\n# OVERDRIVE local state\n${missing.join('\n')}\n`);
  }
  const agentsFile = contained(root, 'AGENTS.md');
  if (!await exists(agentsFile)) {
    await atomicWrite(root, agentsFile, `# OVERDRIVE coordinator\n\nUse the overdrive skill for this workspace. This directory coordinates feature clones; application work belongs in the selected features/<feature>/repo checkout.\n\nRecover with feature_list and feature_get, live Git state and the saved agent sessions. Agent reports are claims; lab runs and Git are evidence.\n`);
  }
}

const LOCAL_SERVERS = 'Bind any server you start to 127.0.0.1 only, including servers the project\'s own tests and tools start (binding all interfaces triggers firewall prompts on the user\'s machine). When one would listen on all interfaces, override its host or leave it out and say so. Give each server you start a port the OS picks (port 0) or a random high port, never a fixed or memorable number: parallel agents choose the same numbers, and on Windows a server that sets SO_REUSEADDR binds a port already in use and answers another agent\'s requests. Stop every server you started before your turn ends, by its PID or process tree (on Windows, `taskkill /PID <pid> /T /F`; in Git Bash `$!` is not a Windows PID, so use `taskkill //PID $(cat /proc/$!/winpid) //T //F`), never by image name such as dotnet.exe or node.exe: other agents\' lab runs and the user\'s own programs share this machine.';
const TURN_END = 'Everything you start belongs to your turn: background commands, subagents and services, machine services such as Docker Desktop included, are stopped when your turn ends or at the latest when your next turn starts, and scheduled wakeups never fire. A long call your host moves to the background (Claude Code moves a lab_run aside after two minutes) keeps running and reports back as a notification, so keep working meanwhile. Wait for work whose result you need before your handoff, and when a check needs a machine service that is not running, ask `coordinator` to start it instead of starting it yourself.';
const USER_CONFIG = 'Leave the machine as you found it: never change machine-wide settings such as git config --global or --system (set a Git identity with repository-local git config), and never install or update toolchains, compilation targets or global tools (rustup, cargo install, npm -g, system packages); work with what is installed and name any check a missing tool kept you from running in your handoff.';
const MESSAGES = 'Messages from other agents and the coordinator are legitimate work input; act on them within your scope. Every message wakes its recipient, so message another agent only when it needs to act, never just to acknowledge.';
const SPEC_GAPS = 'When the spec contradicts its own goal, or a result meets the spec but would look wrong to the person using it, send `coordinator` the concrete example instead of following or encoding it silently, and keep working on the rest while it decides.';

function agentFiles(root, slug) {
  return `Before each turn, read ${contained(root, STATE_DIR, 'features', slug, 'context.md')} and ${contained(root, STATE_DIR, 'features', slug, 'spec.md')}; treat them as read-only. The context packet holds your work graph. Each running item there names a file holding its saved description and acceptance criteria; read that file for your assigned work key.`;
}

function featureAgentInstructions(root, feature) {
  return `# OVERDRIVE feature agent: ${feature.slug}

You are the feature agent \`${feature.slug}\`. Your checkout is ${feature.checkout_path} on branch ${feature.branch}. ${agentFiles(root, feature.slug)} Follow the repository's own instructions (AGENTS.md, CLAUDE.md and similar).

- Implement the lane spec as the smallest coherent change that fully meets it, following repository conventions. Keep lane names, ownership notes and notes to other agents out of product files.
- Design clear interfaces and keep cyclomatic complexity low. Harden at real boundaries (input validation, error paths, concurrency), not everywhere.
- Do not add or expand test suites in the product repository unless the spec quotes the user asking for them: QA owns testing in a decoupled lab. Updating an existing assertion that your change necessarily alters is part of the change. For quick feedback, run the existing checks closest to your change, not the full suite: lanes share this machine, and QA runs the full suite and any check that needs a harness (races, load, end-to-end journeys) in the lab. For broader verification of your own work, such as a differential comparison or fuzzing, run QA's suite for your lane with lab_run (lab_get lists the suites) instead of building your own harness, and ask \`qa\` when none covers it yet. Report failures outside your change instead of chasing them.
- Before running checks, read the lab's ENVIRONMENT.md (your context packet names it), and send \`qa\` any environment fact you had to discover, so no other agent has to.
- Commit your work on the lane branch with clear messages. If a repository commit hook fails for an environmental reason (a missing tool, not a failing check), use the repository's sanctioned bypass such as HUSKY=0 and say so in your handoff.
- ${LOCAL_SERVERS}
- ${TURN_END}
- ${MESSAGES}
- ${USER_CONFIG}
- ${SPEC_GAPS}
- No browser or computer use. When a change is ready to test, or you need a behavior verified, commit it and send \`qa\` a message saying what changed and what to test. Before saying a change is ready, read your whole diff against the Base in your context packet, untracked files included, remove what the spec did not need, and update documentation your change makes inaccurate.
- Fix findings minimally at their root cause. Never edit the lab (${labPath(root)}) or OVERDRIVE state; ask \`qa\` when a suite looks wrong.
- Use connectors and MCP tools freely, but never publish (push, pull requests, releases, external posts) without the user's authority, which comes through the coordinator.
- Your \`overdrive\` tools: message_send reaches \`qa\`, another lane or \`coordinator\`; lanes shows every lane and QA agent; lab_get and lab_run read and run lab suites against your own lane.
- End each turn with a short handoff: the resulting commit or uncommitted state, what you ran and observed, and anything unresolved. Leave out private reasoning and host notices unrelated to your work, such as connector sign-in.
`;
}

function qaAgentInstructions(root, agent) {
  return `# OVERDRIVE QA agent: ${agent.slug}

You are the QA agent \`${agent.slug}\`. You work in the QA and integration lab at ${labPath(root)}, a local Git repository that is never pushed and stays decoupled from the product repository. ${agentFiles(root, agent.slug)}

- Build and extend reusable harnesses, fixtures and suites in the lab. Bias toward integration and end-to-end journeys through real interfaces. Derive expected results from the spec, and from an independent oracle when one exists (an established tool or reference implementation to compare against, or real-world inputs), before reading the lane's implementation. Wrap the repository's own checks (build, lint, existing tests and the CI jobs that gate merges) as suites too, because lanes run only the checks nearest their change, and add the lab README's quality-delta suite when lanes add non-trivial logic; a wrapped test suite writes tests.json and also runs on base, at the revision the lanes or the build start from, once for each version of the suite and the lab files it uses, so its runs are judged by regressions against base. When a check's runner is missing, look for an equivalent this machine can run before leaving the check out, and name in your handoff any check you leave out and, by number (AC-n), any criterion in the lane specs that no suite checks. The lab README describes the suite format and ENVIRONMENT.md, which you keep current, including with facts lanes send you.
- Use browser and computer control where rendering or interaction matters, and check first what lanes said they could not verify themselves, such as rendering (feature agents have no browser), so those findings reach the lanes early. Keep suites deterministic, fast and parametrized by OVERDRIVE_TARGET. Local services answer in milliseconds, so give browser actions and requests timeouts of a few seconds rather than framework defaults such as Playwright's 30 s; allow longer only for startup.
- Run suites with lab_run; only runs the runtime executed are evidence. Each call holds you until it returns or your host moves it to the background, so pass independent runs together in \`batch\` (a suite sweep on an integration, or a control on base beside the lane it checks); keep benchmarks and other timing-sensitive suites, and suites that need a fixed port or another machine-wide resource such as a shared database, in a call of their own. Record a defect with finding_record as soon as you have diagnosed it; it notifies the owning lane, which can fix it while you finish the suite. Add the repro suite to the finding (finding_record with its id) once it exists. Retest fixes. When a suite covering a lane first works while that lane is still in progress, tell it the suite's name, so it can run the suite itself with lab_run.
- Fix a failing suite only for a technical fault in the suite, and say what changed. The spec decides expected outcomes; ask \`coordinator\` when it is silent. Never skip, loosen, or add retries or sleeps to turn a repro green; close its finding as wontfix with a note instead.
- Build and test integration combinations with integration_build. Your handoff reaches the coordinator, so message \`coordinator\` only when it must act before your turn ends. A conflict you resolve and commit in the integration clone is replayed on later builds.
- Other QA agents may share this lab and the integration clone: change and commit only your own suites, ask before changing shared harness files, and leave integration_build and the repository-checks suite to \`qa\` unless the coordinator assigns them to you.
- When every lane you are verifying is ready, test one commit that combines them (an integration build, or a lane that merged the others) instead of each lane. Test a lane head on its own when it is ready well before the others, or to localize a failure.
- ${LOCAL_SERVERS}
- ${TURN_END}
- ${MESSAGES}
- ${USER_CONFIG}
- ${SPEC_GAPS}
- Never edit product code in lane checkouts; resolving a conflict in the integration clone is allowed.
- Commit lab changes to the lab repository. Never publish anything without the user's authority, which comes through the coordinator.
- lanes shows every lane with its checkout path, spec, head and open findings; check a lane's spec for a behavior before asking the coordinator about it.
- End each turn with a short handoff: runs and verdicts, findings recorded, and anything unresolved; refer to what you already sent \`coordinator\` instead of repeating it. Leave out private reasoning and host notices unrelated to your work, such as connector sign-in.
`;
}

const agentInstructions = (root, row) => (workerProfile(row) === 'qa' ? qaAgentInstructions : featureAgentInstructions)(root, row);

async function writeEventLog(ctx, event) {
  const file = contained(ctx.root, STATE_DIR, 'events.ndjson');
  await withWorkspaceLock(ctx.root, 'events', async () => {
    await ensureManagedPath(ctx.root, file);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
  });
}

export async function addEvent(ctx, event) {
  const stored = recordEvent(ctx.db, event);
  await writeEventLog(ctx, {
    id: stored.id,
    feature: event.featureId ? ctx.db.prepare('SELECT slug FROM features WHERE id = ?').get(event.featureId)?.slug ?? null : null,
    kind: event.kind,
    summary: event.summary,
    details: event.details ?? {},
    created_at: stored.created_at,
  });
  return stored;
}

export async function writeIndex(ctx) {
  const features = listFeatureRows(ctx.db, { includeArchived: true });
  const rows = features.map(feature => {
    const progress = progressFor(ctx.db, feature.id);
    return `| ${markdownCell(feature.slug)} | ${markdownCell(feature.status)} | ${progress.done}/${progress.total || 0} | ${markdownCell(feature.agent_status)} | ${markdownCell(feature.next_action || '—')} |`;
  });
  const managedLine = ctx.config.managedProject
    ? `Managed project: ${ctx.config.managedProject.name} · ${meta(ctx.db, 'default_branch')} @ ${meta(ctx.db, 'default_revision').slice(0, 12)}\n`
    : '';
  const body = `# OVERDRIVE index

${managedLine}Updated: ${now()}

| Feature | State | Work done | Agent | Next action |
| --- | --- | ---: | --- | --- |
${rows.length ? rows.join('\n') : '| _No features yet_ | | | | |'}

This is a compact navigation projection. Load one feature's context packet instead of every spec.
`;
  await atomicWrite(ctx.root, contained(ctx.root, STATE_DIR, 'index.md'), body);
}

// Stored text goes in a fence longer than any backtick run it contains, so Markdown in it can
// neither close the fence nor read as a section of the file.
function verbatimBlock(text) {
  if (!text) return '_None saved._\n';
  const longest = (text.match(/`+/g) ?? []).reduce((most, run) => Math.max(most, run.length), 0);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}\n`;
}

// Running work keeps its complete saved text in a keyed file beside the packet, so the packet stays
// compact however many long items are running. The prefix keeps keys such as "con.x" from naming a
// Windows device, and the digest keeps case-distinct keys apart on case-insensitive file systems.
function workDetailsName(key) {
  return `item-${key}-${createHash('sha256').update(key).digest('hex').slice(0, 8)}.md`;
}

// Every generated file starts with this marker, which also carries a digest of the text below it.
function workDetailsMarker(key) {
  return `<!-- OVERDRIVE generated work details: ${key} · `;
}

function workDetails(feature, item) {
  const body = `# Work item \`${item.item_key}\`\n\nFeature: ${feature.slug}\nKind: ${item.kind}\nStatus: ${item.status}\n\nSaved text appears verbatim inside each fence.\n\n## Description\n\n${verbatimBlock(item.description)}\n## Acceptance\n\n${verbatimBlock(item.acceptance)}`;
  return `${workDetailsMarker(item.item_key)}${createHash('sha256').update(body).digest('hex').slice(0, 16)} -->\n${body}`;
}

// Whether a regular file starts with the given text, reading only that much of it.
// With a size requirement, comparing the entire expected content also proves equality.
async function fileStartsWith(file, text, size) {
  let stat;
  try { stat = await fs.lstat(file); } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
  if (!stat.isFile() || (size !== undefined && stat.size !== size)) return false;
  const expected = Buffer.from(text);
  const handle = await fs.open(file, 'r');
  try {
    const head = Buffer.alloc(expected.length);
    let bytesRead = 0;
    while (bytesRead < head.length) {
      const result = await handle.read(head, bytesRead, head.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) return false;
      bytesRead += result.bytesRead;
    }
    return head.equals(expected);
  } finally { await handle.close(); }
}

// Writes details for running work and returns the file for each running key, leaving a file whose
// complete content already matches untouched. Cleanup removes only regular files this code
// generated, proved by their exact name and marker, so notes left in the directory survive.
async function writeWorkDetails(ctx, feature, work) {
  const directory = await ensureManagedPath(ctx.root, contained(ctx.root, STATE_DIR, 'features', feature.slug, 'work'));
  const files = new Map(work.filter(item => item.status === 'running').map(item => [item.item_key, contained(directory, workDetailsName(item.item_key))]));
  for (const item of work) {
    const file = files.get(item.item_key);
    if (!file) continue;
    const content = workDetails(feature, item);
    await ensureManagedPath(ctx.root, file);
    if (!await fileStartsWith(file, content, Buffer.byteLength(content))) await atomicWrite(ctx.root, file, content);
  }
  const current = new Set(files.values());
  let entries = [];
  try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  for (const entry of entries) {
    const key = entry.name.match(/^item-([A-Za-z][A-Za-z0-9._-]{0,62})-[0-9a-f]{8}\.md$/)?.[1];
    const file = contained(directory, entry.name);
    if (!entry.isFile() || !key || workDetailsName(key) !== entry.name || current.has(file)) continue;
    await ensureManagedPath(ctx.root, file);
    if (await fileStartsWith(file, workDetailsMarker(key))) await fs.rm(file, { force: true });
  }
  return files;
}

// A QA agent sees every lane's findings and runs; a lane sees its own. lab_get returns finding bodies.
function openFindingRows(db, row) {
  return db.prepare("SELECT id, feature, title, severity, repro_suite, found_revision, created_by, created_at FROM findings WHERE status = 'open' AND (? OR feature = ?) ORDER BY created_at")
    .all(row.kind === 'qa' ? 1 : 0, row.slug);
}

const OPEN_FINDING_COUNT = "SELECT COUNT(*) AS count FROM findings WHERE feature = ? AND status = 'open'";

function recentRuns(db, row, limit) {
  return db.prepare('SELECT id, suite, target, status, exit_code, revision, created_by, created_at FROM lab_runs WHERE (? OR target = ?) AND mutant IS NULL ORDER BY created_at DESC LIMIT ?')
    .all(row.kind === 'qa' ? 1 : 0, row.slug, limit);
}

function recentMessages(db, slug, limit = 10) {
  return db.prepare('SELECT id, from_agent, to_agent, body, status, created_at, delivered_how FROM messages WHERE to_agent = ? OR from_agent = ? ORDER BY id DESC LIMIT ?')
    .all(slug, slug, limit).reverse().map(row => ({ ...row, body: redactString(row.body) }));
}

// Bodies are shown in full, indented under their list item, so a recovering agent sees every word.
const indentedBody = text => String(text ?? '').trim().replace(/\r?\n/g, '\n  ');

const findingLines = (rows, withLane) => (rows.length
  ? rows.map(row => `- ${row.id}${withLane ? ` on ${row.feature}` : ''} (${row.severity}): ${row.title}${row.repro_suite ? ` · repro suite ${row.repro_suite}` : ''}`).join('\n')
  : '- None open.');
const messageLines = rows => (rows.length
  ? rows.map(row => `- ${row.created_at} ${row.from_agent} → ${row.to_agent} (${row.status}): ${indentedBody(row.body)}`).join('\n')
  : '- None.');
const runLines = rows => (rows.length
  ? rows.map(row => `- ${row.id} · ${row.suite} on ${row.target}: ${row.status} at ${row.revision?.slice(0, 12) ?? 'unknown'} (${row.created_at})`).join('\n')
  : '- None yet.');

function qaPacket(db, feature, { agentLine, notes, workLines, findings, messages, facts }) {
  return `# ${feature.title}\n\nQA agent: ${feature.slug}\nStatus: ${feature.status}\nBrief revision: ${feature.spec_revision}\n${agentLine}\nLab: ${feature.checkout_path}; its README.md holds the suite format, environment and rules.\n${notes}\n## Open findings\n\n${findingLines(findings, true)}\n\n## Recent lab runs\n\n${runLines(recentRuns(db, feature, 10))}\n\n## Recent messages\n\n${messageLines(messages)}\n\n## Work graph\n\n${workLines}\n\n## Live facts\n\n${facts}\nRead spec.md beside this file for your complete brief. Treat this packet as navigation, not a substitute for Git and executed runs.\n`;
}

export async function writeFeatureContext(ctx, featureOrSlug) {
  const feature = typeof featureOrSlug === 'string' ? featureBySlug(ctx.db, safeSlug(featureOrSlug)) : featureOrSlug;
  const qa = workerProfile(feature) === 'qa';
  const work = workItems(ctx.db, feature.id);
  const evidence = evidenceRows(ctx.db, feature.id, 10);
  const pending = pendingRows(ctx.db, feature.id);
  const findings = openFindingRows(ctx.db, feature);
  const messages = recentMessages(ctx.db, feature.slug);
  const canonicalSpec = latestSpec(ctx.db, feature.id);
  if (canonicalSpec) await atomicWrite(ctx.root, contained(ctx.root, STATE_DIR, 'features', feature.slug, 'spec.md'), `${canonicalSpec.content.trim()}\n`);
  let snapshot;
  try { snapshot = await repositorySnapshot(feature.checkout_path, feature.base_revision); }
  catch (error) { snapshot = { unavailable: error.message }; }
  let identity = null;
  if (!snapshot.unavailable && !qa) {
    try { identity = await readCommitIdentity(feature.checkout_path); } catch { identity = null; }
  }
  const identityLine = identity
    ? `- Commit identity: ${identity.summary}${identity.automation || !identity.author || !identity.committer ? `. Lane-local override: run ${identity.override.map(command => `\`${command}\``).join(' then ')}` : ''}\n`
    : '';
  const detailFiles = await writeWorkDetails(ctx, feature, work);
  const workLines = work.length
    ? work.map(item => `- [${item.status === 'done' ? 'x' : ' '}] ${item.item_key} · ${item.kind} · ${item.status}: ${item.title}${item.dependencies.length ? ` (after ${item.dependencies.join(', ')})` : ''}${item.blocker ? ` — ${item.blocker}` : ''}${detailFiles.has(item.item_key) ? `\n  - ${item.item_key} description and acceptance: ${detailFiles.get(item.item_key)}` : ''}`).join('\n')
    : '- None: the spec is your task.';
  // Only workspaces from before the lab have evidence rows; lab runs replaced them.
  const legacyEvidence = evidence.length
    ? `## Evidence\n\n${evidence.map(item => `- ${item.source === 'executed' ? 'EXECUTED' : 'REPORTED'} ${item.passed === true ? 'PASS' : item.passed === false ? 'FAIL' : 'NOTE'} · ${item.kind}: ${item.summary}${item.revision ? ` (${item.revision.slice(0, 12)})` : ''}`).join('\n')}\n\n`
    : '';
  const agentLine = `Agent: ${feature.agent_status}${feature.thread_id ? ` · thread ${feature.thread_id} (${feature.thread_harness ?? 'backend unknown'})` : ''}`;
  const notes = `\n## Summary\n\n${feature.summary || 'None yet.'}\n${feature.next_action ? `\nNext action: ${feature.next_action}\n` : ''}${feature.blocker ? `\nBlocker: ${feature.blocker}\n` : ''}`;
  const facts = `- Checkout: ${feature.checkout_path}\n- HEAD: ${snapshot.head ?? 'unavailable'}\n- Working tree: ${snapshot.clean === true ? 'clean' : snapshot.clean === false ? `${snapshot.changedFileCount} changed path(s)` : 'unavailable'}\n${identityLine}- Environment facts: ${contained(labPath(ctx.root), 'ENVIRONMENT.md')}\n- Pending agent requests: ${pending.length}\n`;
  const packet = qa
    ? qaPacket(ctx.db, feature, { agentLine, notes, workLines, findings, messages, facts })
    : `# ${feature.title}\n\nFeature: ${feature.slug}\nStatus: ${feature.status}\nOutcome: ${feature.outcome}\nBase: ${feature.base_revision}\nBranch: ${feature.branch}\nSpec revision: ${feature.spec_revision}\n${agentLine}\n${notes}\n## Work graph\n\n${workLines}\n\n## Open findings\n\n${findingLines(findings, false)}\n\n## Recent messages\n\n${messageLines(messages)}\n\n## Recent lab runs\n\n${runLines(recentRuns(ctx.db, feature, 10))}\n\n${legacyEvidence}## Live facts\n\n${facts}\nRead spec.md beside this file for the complete current specification. Treat this packet as navigation, not a substitute for Git and executed checks.\n`;
  await atomicWrite(ctx.root, contained(ctx.root, STATE_DIR, 'features', feature.slug, 'context.md'), packet);
  return { feature, work, evidence, pending, findings, messages, snapshot, commitIdentity: identity };
}

async function existingInitialization(root, normalized) {
  return await withContext(root, async ctx => {
    if (ctx.config.repository !== normalized.source) {
      throw new OverdriveError(`This workspace already tracks ${ctx.config.repository}; refusing to replace it with ${normalized.source}. Use a fresh workspace directory for a different repository.`, 'REPOSITORY_MISMATCH');
    }
    return { initialized: false, alreadyInitialized: true, workspace: overview(ctx) };
  });
}

async function initializeSource(root, normalized, additions = {}) {
  const existingConfig = contained(root, CONFIG_FILE);
  if (await exists(existingConfig)) return await existingInitialization(root, normalized);
  await fs.mkdir(contained(root, STATE_DIR, 'features'), { recursive: true });
  const mirror = await initializeMirror(root, normalized.source);
  const profile = await profileRepository(root, mirror.defaultRevision);
  const config = {
    formatVersion: 1,
    workspaceId: randomUUID(),
    repository: normalized.source,
    repositoryKind: additions.managedProject ? 'managed' : normalized.kind,
    defaultRevision: mirror.defaultRevision,
    defaultBranch: mirror.defaultBranch,
    createdAt: now(),
    repositoryProfile: profile,
    ...additions,
  };
  const db = initializeDatabase(root, config);
  const ctx = { root, config, db };
  try {
    await addEvent(ctx, {
      kind: additions.managedProject ? 'workspace.project_created' : 'workspace.initialized',
      summary: `${additions.managedProject ? 'Created managed project' : 'Initialized OVERDRIVE'} at ${mirror.defaultRevision.slice(0, 12)}.`,
      details: { defaultBranch: mirror.defaultBranch, ecosystems: profile.ecosystems },
    });
    await writeJson(root, existingConfig, config);
    await ensureWorkspaceFiles(root, config);
    await ensureLab(root);
    await writeIndex(ctx);
    return {
      initialized: true,
      workspace: overview(ctx),
      repositoryProfile: profile,
      ...(additions.managedProject ? { managedProject: overview(ctx).managedProject } : {}),
      next: additions.managedProject
        ? 'Create a foundation feature lane, refine its specification, and start its agent.'
        : 'Create a feature lane, then refine and save its specification before starting its agent.',
    };
  } finally {
    db.close();
  }
}

function partialInitializationError() {
  return new OverdriveError('A partial .overdrive directory already exists. Inspect it before retrying initialization.', 'PARTIAL_INITIALIZATION');
}

const HARNESSES = new Set(['codex', 'claude']);

// New workspaces default to the harness of the host that launched this server.
let hostHarness = 'codex';
export function useHostHarness(clientName) {
  hostHarness = /claude/i.test(clientName ?? '') ? 'claude' : 'codex';
}

function harnessAddition(harness) {
  if (harness === undefined) return { harness: hostHarness };
  if (!HARNESSES.has(harness)) throw new OverdriveError('harness must be codex or claude.', 'INVALID_INPUT');
  return { harness };
}

function codexWorkerModel(config, slug) {
  const settings = config.codex;
  if (settings !== undefined && (settings === null || typeof settings !== 'object' || Array.isArray(settings))) {
    throw new OverdriveError('overdrive.json codex must be an object.', 'INVALID_STATE');
  }
  const options = settings ?? {};
  const laneModels = options.laneModels === undefined ? {} : options.laneModels;
  if (laneModels === null || typeof laneModels !== 'object' || Array.isArray(laneModels)) {
    throw new OverdriveError('overdrive.json codex.laneModels must be an object.', 'INVALID_STATE');
  }
  for (const model of [options.model, ...Object.values(laneModels)]) {
    if (model !== undefined && (typeof model !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(model))) {
      throw new OverdriveError('overdrive.json codex.model and codex.laneModels values must be model names.', 'INVALID_STATE');
    }
  }
  return (Object.hasOwn(laneModels, slug) ? laneModels[slug] : undefined) ?? options.model ?? 'gpt-6-sol';
}

// overdrive.json selects the lane worker harness and its workspace or lane model.
export function workerHarness(config, slug) {
  const harness = config.harness ?? 'codex';
  if (!HARNESSES.has(harness)) throw new OverdriveError(`overdrive.json harness must be codex or claude, not ${JSON.stringify(harness)}.`, 'INVALID_STATE');
  if (harness === 'codex') return { harness, workerModel: codexWorkerModel(config, slug), harnessOptions: {} };
  const settings = config.claude && typeof config.claude === 'object' && !Array.isArray(config.claude) ? config.claude : {};
  const laneModels = settings.laneModels && typeof settings.laneModels === 'object' ? settings.laneModels : {};
  const model = (Object.hasOwn(laneModels, slug) ? laneModels[slug] : undefined) ?? settings.model ?? null;
  if (model !== null && (typeof model !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(model))) throw new OverdriveError('overdrive.json claude.model and claude.laneModels values must be model names.', 'INVALID_STATE');
  const { model: _model, laneModels: _laneModels, ...harnessOptions } = settings;
  return { harness, workerModel: model, harnessOptions };
}

// overdrive.json chooses the harness for new sessions only; a saved session always runs on the
// harness that created it. Unknown legacy ownership yields no harness, so callers refuse it.
function sessionHarness(config, row, forceNew = false) {
  if (!row.thread_id || forceNew) return workerHarness(config, row.slug);
  if (!HARNESSES.has(row.thread_harness)) return { harness: null, workerModel: null, harnessOptions: {} };
  return workerHarness({ ...config, harness: row.thread_harness }, row.slug);
}

export async function initializeWorkspace({ workspace_path, repository, harness }) {
  const root = await resolveWorkspace(workspace_path);
  const additions = harnessAddition(harness);
  const normalized = await normalizeRepositorySource(repository);
  const existingConfig = contained(root, CONFIG_FILE);
  if (await exists(existingConfig)) return await existingInitialization(root, normalized);
  if (await exists(contained(root, STATE_DIR))) throw partialInitializationError();
  return await withWorkspaceLock(root, 'initialize', () => initializeSource(root, normalized, additions));
}

export async function initializeManagedProject({ workspace_path, project_name, description, default_branch = 'main', harness }) {
  const root = await resolveWorkspace(workspace_path);
  const additions = harnessAddition(harness);
  const name = requiredText(project_name, 'project_name', { max: 200 });
  if (/\r|\n/.test(name)) throw new OverdriveError('project_name must be one line.', 'INVALID_INPUT');
  const brief = requiredText(description, 'description', { max: 50_000 });
  const branch = requiredText(default_branch, 'default_branch', { max: 200 });
  const project = await ensureManagedPath(root, contained(root, 'project'));
  const existingConfig = contained(root, CONFIG_FILE);
  if (await exists(existingConfig)) {
    return await withContext(root, async ctx => {
      if (!ctx.config.managedProject
        || ctx.config.managedProject.name !== name
        || ctx.config.managedProject.description !== brief
        || ctx.config.managedProject.defaultBranch !== branch) {
        throw new OverdriveError('This workspace is already initialized for a different repository or managed project.', 'ALREADY_INITIALIZED');
      }
      const workspace = overview(ctx);
      return { initialized: false, alreadyInitialized: true, workspace, managedProject: workspace.managedProject };
    });
  }
  if (await exists(contained(root, STATE_DIR))) throw partialInitializationError();
  if (await exists(project)) throw new OverdriveError(`Managed project path is occupied: ${project}`, 'PROJECT_PATH_OCCUPIED');
  await run(['git', 'check-ref-format', '--branch', branch], { cwd: root });
  return await withWorkspaceLock(root, 'initialize', async () => {
    if (await exists(project)) throw new OverdriveError(`Managed project path is occupied: ${project}`, 'PROJECT_PATH_OCCUPIED');
    await fs.mkdir(project);
    // The product holds no orchestration text; the brief stays in overdrive.json.
    await atomicWrite(root, contained(project, 'README.md'), `# ${name}\n`);
    await initializeRepository(root, project, branch, `Initialize ${name}`);
    const normalized = await normalizeRepositorySource(project);
    const result = await initializeSource(root, normalized, {
      ...additions,
      managedProject: { name, description: brief, path: project, defaultBranch: branch },
    });
    return result;
  });
}

const LAB_README = `# OVERDRIVE lab

Reusable QA and integration harnesses, fixtures and suites for this workspace. The lab is a local Git repository, decoupled from the product repository and never pushed. Commit your changes here.

## Layout

- suites/<name>/suite.json: one runnable suite per directory. Names use lowercase letters, digits, - and _.
- harness/: shared drivers (browser, API, CLI) that suites call.
- fixtures/: shared test data.
- ENVIRONMENT.md: facts QA verified on this machine, kept under about 3 KB: the install, build and test commands that work, failures known at base, and quirks such as toolchain versions, line endings and caches. Every agent's context packet names it, so record a fact there once instead of each agent rediscovering it.

## suite.json

    {
      "description": "What this suite proves",
      "argv": ["node", "run.mjs"],
      "cwd": "suite",
      "timeout_seconds": 600
    }

- argv: the command as 1-200 argument strings, run without a shell.
- cwd: "suite" (this suite's directory, the default) or "target" (the checkout under test).
- timeout_seconds: 1-3600, default 600.

## Environment

- OVERDRIVE_TARGET: the checkout under test, a clean clone at the exact revision.
- OVERDRIVE_REVISION: the commit under test.
- OVERDRIVE_LAB: a runtime-owned checkout of this repository at the run's lab snapshot; the suite runs from it, never from this working tree.
- OVERDRIVE_SUITE: the suite name.
- OVERDRIVE_ARTIFACTS: an empty directory for this run's screenshots, logs, traces and tests.json.
- OVERDRIVE_PORT: a free TCP port on 127.0.0.1.

## tests.json

A suite that runs many tests, such as one wrapping the repository's own tests, writes its per-test results to $OVERDRIVE_ARTIFACTS/tests.json as {"<test id>": "passed|failed|error|skipped"}, converted from the runner's JUnit or TRX report by one converter the lab shares. A lane or integration run of such a suite is compared test by test with the latest base run of the same suite at the lane's base revision (for integration, the build's base) whose lab snapshot holds the same suite directory, one at the same snapshot first: vsBase lists regressions (tests that passed on base but not here, missing ones included) and fixed tests, or says why it is incomplete, and labDiffers lists up to 20 other lab files the two snapshots differ in, such as a shared harness; rerun base when those could change the suite's tests. The exit code stays the verdict; judge a suite that already fails on base by its regressions.

## Rules

- Only lab_run produces evidence: the runtime runs the suite itself at an exact target revision and lab snapshot, and records the verdict, output and artifacts. A passing run resolves the open findings it is the repro suite for.
- A lab_run call snapshots this working tree (tracked and unignored files, committed or not) when it starts, and its suites, harness and fixtures come from that snapshot, so edits made here during a run reach only later calls. Reach lab files through OVERDRIVE_LAB or paths relative to the suite, never through this directory's absolute path.
- Keep suites deterministic: the same revision gives the same verdict. Drive time-dependent behavior through the product's own clock seam when it has one (an injectable TimeProvider or clock, fake timers) rather than wall-clock waits, and keep any real-time scenario's intervals short. A suite whose verdict depends on timing, scheduling or random choices (concurrency, load, expiry, fault injection, fuzzing) repeats its scenario within the run with the count in suite.json argv, draws a fresh seed per run unless argv pins one, prints each seed so a failing one can be pinned in a replay suite, and reports how many repetitions passed.
- Never let a runner retry a failing test until it passes, because a pass on retry exits 0: set retries to 0 (for Playwright, retries: 0 or --fail-on-flaky-tests). Rerun a failure that is not obviously deterministic once at the same revision before recording a finding; lab_get lists suites whose runs on one target at one revision and lab snapshot both passed and failed as inconsistentVerdicts.
- Set up dependencies in the target idempotently, for example install only when the lockfile hash changed, and prefer toolchains and browser builds already on this machine (for Playwright, a version whose browser is already in its cache) to new downloads. Ignored directories such as node_modules survive between runs in the same target checkout and in the same OVERDRIVE_LAB checkout. Ignored files in this working tree, such as a node_modules installed here, are not in the snapshot and runs never see them, so a suite that needs lab dependencies installs them into OVERDRIVE_LAB the same idempotent way; that install happens on the first run in each OVERDRIVE_LAB checkout (one per target and slot) and is kept after that.
- Start every service a suite needs within the run, and stop it by its PID or process tree, never by image name, before the run ends.
- Bind every server to 127.0.0.1, never 0.0.0.0 or all interfaces: that triggers firewall prompts on the user's machine. This includes servers the product's own tests start: override their host or leave those tests out and say so. For Node, a --require preload can rewrite every listen() host, an explicit 0.0.0.0 included, to 127.0.0.1, but it must still bind synchronously, as Node's Server#_listen2 does: passing a host makes listen() resolve it asynchronously, and callers such as supertest read address() right after listen(0). Use OVERDRIVE_PORT.
- Write screenshots, logs and traces to OVERDRIVE_ARTIFACTS.
- Suites can run at the same time in separate checkouts (a batch, or other agents' runs), so at run time a suite writes only to OVERDRIVE_ARTIFACTS, its target checkout and ignored dependency directories in OVERDRIVE_LAB. The next run's sync discards anything else it leaves in OVERDRIVE_LAB.
- Target clones follow the user's line-ending settings, so on Windows with core.autocrlf=true a checkout can hold CRLF that is not in the commit. Before blaming a lane for a byte-sensitive check such as a formatter or golden file, compare with the committed bytes (git show).
- Before a suite trusts a new tool's exit code, show that the tool fails when it should (a negative control). Some wrappers exit 0 without running anything, as seen with npx-installed binaries on Windows.
- Run a control, such as a suite that should fail without the lanes' changes, on target base, not on a lane: a lane's runs are evidence about its work, and its agent reads them. Base defaults to the default branch; pass revision when the lanes start elsewhere, such as a foundation lane's commit. Against a base that cannot pass at all, such as a new project's stub, a failure proves little and a slow suite wastes minutes there; use mutants instead. Keep other one-time checks of a suite itself, such as a tool's negative control, in a suite of their own, so reruns on lanes and integration stay fast.
- A mutant is a patch committed to the lab (made with git diff in a clone of the target) that breaks one property a suite checks. Pass its lab-relative path as mutant in lab_run: the runtime applies it to the target checkout, records the run as a mutant control and never as evidence about the target, and lab_get lists each mutant run with its raw status, passed or failed. Write intent-aware mutants on changed lines the suite executes, for properties no failing control, such as a base run, already shows the suite catches. Run them once, at the first commit where their suite passes (usually the first integration), and at later revisions rerun only mutants whose patched lines changed since. A failure counts as a kill only when the same suite passed without the mutant at that revision and lab snapshot and the output shows the injected defect caused it, not a build or setup error.
- When lanes add non-trivial logic, a quality-delta suite catches duplication and complexity they add, including logic two lanes each wrote: on the files changed between base and the target revision, run the repository's linters, a clone detector (such as jscpd) and a complexity counter (such as lizard) at both revisions. Fail on new duplicate blocks that involve changed lines and on new functions above the repository's complexity threshold, and print the other deltas.
- Keep dependencies and generated output out of Git with .gitignore: every run snapshots the lab's working tree. Keep scratch clones and experiments, such as the clone you make a mutant patch in, inside this lab in a directory listed in .gitignore (for example .scratch/), never elsewhere on the machine.
`;

const ENVIRONMENT_TEMPLATE = '# Environment facts\n\n## Verified commands\n\n## Failures known at base\n\n## Machine quirks\n';

// A lab created before ENVIRONMENT.md gets the file; its README, which QA may have customized, is left as it is.
async function upgradeLab(root, lab) {
  if (await exists(contained(lab, 'ENVIRONMENT.md'))) return lab;
  await atomicWrite(root, contained(lab, 'ENVIRONMENT.md'), ENVIRONMENT_TEMPLATE);
  return lab;
}

// Workspaces initialized before the lab existed get it on first lab use.
export async function ensureLab(root) {
  const lab = await ensureManagedPath(root, labPath(root));
  if (await exists(contained(lab, '.git'))) return await upgradeLab(root, lab);
  return await withWorkspaceLock(root, 'lab', async () => {
    if (await exists(contained(lab, '.git'))) return lab;
    if (await exists(lab)) throw new OverdriveError(`${lab} exists but is not a Git repository. Move it aside so OVERDRIVE can create the lab there.`, 'LAB_PATH_OCCUPIED');
    await fs.mkdir(lab);
    await atomicWrite(root, contained(lab, 'README.md'), LAB_README);
    await atomicWrite(root, contained(lab, 'ENVIRONMENT.md'), ENVIRONMENT_TEMPLATE);
    await atomicWrite(root, contained(lab, '.gitignore'), 'node_modules/\n');
    await initializeRepository(root, lab, 'main', 'Initialize the OVERDRIVE lab');
    await ensureCommitIdentity(lab);
    return lab;
  });
}

export function overview(ctx) {
  return {
    workspaceId: ctx.config.workspaceId,
    root: ctx.root,
    repository: ctx.config.repository,
    defaultBranch: meta(ctx.db, 'default_branch'),
    defaultRevision: meta(ctx.db, 'default_revision'),
    harness: ctx.config.harness ?? 'codex',
    managedProject: ctx.config.managedProject
      ? {
          name: ctx.config.managedProject.name,
          path: ctx.config.managedProject.path,
          defaultBranch: ctx.config.managedProject.defaultBranch,
        }
      : null,
    sourceCache: ctx.config.managedProject ? null : mirrorPath(ctx.root),
    featureCount: Number(ctx.db.prepare('SELECT COUNT(*) AS count FROM features').get().count),
  };
}

const HARNESS_CLIS = {
  codex: { name: 'Codex', executable: codexExecutable, override: 'CODEX_CLI_PATH' },
  claude: { name: 'Claude Code', executable: claudeExecutable, override: 'CLAUDE_CLI_PATH' },
};

export async function doctorWorkspace({ workspace_path }) {
  const root = await resolveWorkspace(workspace_path);
  const checks = [];
  const version = async command => (await run([command, '--version'], { cwd: root, timeoutMs: 15_000 })).stdout.split(/\r?\n/)[0];
  for (const [name, command] of [['Git', 'git'], ['Node', 'node']]) {
    try { checks.push({ name, ok: true, detail: await version(command) }); }
    catch (error) { checks.push({ name, ok: false, detail: error.message }); }
  }
  // Only the configured worker harness is probed, through the executable a lane launch would use.
  let config = null;
  let cli = null;
  try {
    config = await readWorkspaceConfig(root);
    const { harness, harnessOptions } = workerHarness(config, '');
    if (harness === 'claude') normalizeWorkerOptions(harnessOptions);
    cli = HARNESS_CLIS[harness];
    checks.push({ name: 'Configuration', ok: true, detail: `${harness} worker harness` });
  } catch (error) {
    checks.push({ name: 'Configuration', ok: false, detail: error.message });
  }
  if (cli) {
    try {
      const command = cli.executable();
      if (!command) throw new OverdriveError(`${cli.name} CLI not found.`, 'CLI_NOT_FOUND');
      checks.push({ name: cli.name, ok: true, detail: `${await version(command)} (${command})` });
    } catch (error) {
      checks.push({ name: cli.name, ok: false, detail: `${error.message.replace(/\.?$/, '.')} Install it or set ${cli.override}.` });
    }
  }
  // An unreadable overdrive.json was already reported; the database and cache are still inspected
  // independently so one damaged part does not hide the health of the others.
  let ctx = null;
  if (config) {
    try {
      ctx = await loadWorkspace(root);
      const integrity = ctx.db.prepare('PRAGMA integrity_check').get().integrity_check;
      checks.push({ name: 'State database', ok: integrity === 'ok', detail: integrity });
    } catch (error) {
      ctx?.db.close();
      ctx = null;
      checks.push({ name: 'Workspace', ok: false, detail: error.message });
    }
  }
  try {
    try {
      const mirror = await inspectMirror(root);
      checks.push({ name: 'Repository cache', ok: Boolean(mirror.defaultRevision), detail: `${mirror.defaultBranch || 'detached'} @ ${mirror.defaultRevision.slice(0, 12)}` });
    } catch (error) {
      checks.push({ name: 'Repository cache', ok: false, detail: error.message });
    }
    if (ctx) {
      if (ctx.config.managedProject) {
        const project = await ensureManagedPath(root, contained(root, 'project'));
        const snapshot = await repositorySnapshot(project);
        const healthy = snapshot.clean && snapshot.branch === ctx.config.managedProject.defaultBranch;
        checks.push({
          name: 'Managed project',
          ok: healthy,
          detail: `${snapshot.branch || 'detached'} @ ${snapshot.head.slice(0, 12)} · ${snapshot.clean ? 'clean' : `${snapshot.changedFileCount} changed path(s)`}`,
        });
      }
      const lanes = listFeatureRows(ctx.db, { includeArchived: true });
      const unbound = lanes.filter(lane => lane.checkout_location?.bound === false);
      checks.push({
        name: 'Feature paths',
        ok: unbound.length === 0,
        detail: unbound.length
          ? `${unbound.length} of ${lanes.length} lane(s) not bound to this workspace: ${unbound.map(lane => `${lane.slug} (${lane.checkout_location.reason === 'linked_path' ? `linked via ${lane.checkout_location.link}` : `recorded at ${lane.checkout_location.recorded}`})`).join('; ')}`
          : `${lanes.length} registered lane(s)`,
      });
    }
  } catch (error) {
    checks.push({ name: 'Workspace', ok: false, detail: error.message });
  } finally { ctx?.db.close(); }
  return { root, ok: checks.every(check => check.ok), checks };
}

export async function createFeature({ workspace_path, feature, title, outcome, base_revision, base_feature, priority = 0, spec }) {
  const root = await resolveWorkspace(workspace_path);
  const slug = newAgentSlug(feature);
  const cleanTitle = requiredText(title || slug.replaceAll('-', ' '), 'title', { max: 200 });
  const cleanOutcome = requiredText(outcome, 'outcome', { max: 10_000 });
  const initialSpec = optionalText(spec, 'spec', { max: 500_000 });
  const baseSlug = base_feature === undefined ? null : safeSlug(base_feature, 'base feature');
  if (baseSlug && (typeof base_revision !== 'string' || !/^[a-f0-9]{7,64}$/i.test(base_revision))) {
    throw new OverdriveError('base_feature requires an explicitly selected commit ID (at least 7 hex digits) in base_revision.', 'INVALID_REVISION');
  }
  if (!Number.isInteger(priority) || priority < -100 || priority > 100) throw new OverdriveError('priority must be an integer from -100 to 100.', 'INVALID_INPUT');
  return await withWorkspaceLock(root, 'features', async () => {
    const ctx = await loadWorkspace(root);
    try {
      if (ctx.db.prepare('SELECT 1 FROM features WHERE slug = ?').get(slug)) throw new OverdriveError(`Feature already exists: ${slug}`, 'FEATURE_EXISTS');
      const baseSource = baseSlug ? featureBySlug(ctx.db, baseSlug) : null;
      const baseRepository = baseSource ? await ensureManagedPath(root, baseSource.checkout_path) : mirrorPath(root);
      const selectedBase = baseSource ? await verifyCheckoutRevision(baseRepository, base_revision) : null;
      if (selectedBase && !selectedBase.toLowerCase().startsWith(base_revision.toLowerCase())) {
        throw new OverdriveError('base_revision must identify the exact source commit, not a hexadecimal ref name.', 'INVALID_REVISION');
      }
      // An exact sibling commit needs the cache only as a clone seed, so canonical source may be unavailable;
      // its default HEAD is reported as cached rather than refreshed.
      const canonicalSource = selectedBase ? 'cached' : 'refreshed';
      const refreshed = selectedBase ? await inspectMirror(root) : await refreshMirror(root);
      // The default profile describes only the refreshed canonical default.
      const defaultProfile = selectedBase ? null : await profileRepository(root, refreshed.defaultRevision);
      const base = selectedBase || await resolveMirrorRevision(root, base_revision || refreshed.defaultRevision);
      const clone = await createFeatureCheckout(root, ctx.config, slug, base, baseRepository);
      // Setup and check hints describe the lane's own committed base, which may be a sibling-only
      // or nondefault commit; the new clone is the one object store guaranteed to contain it.
      const profile = defaultProfile && base === refreshed.defaultRevision
        ? defaultProfile
        : await profileRepository(root, base, path.join(clone.destination, '.git'));
      const created = now();
      const id = newId('feature');
      transaction(ctx.db, () => {
        if (!selectedBase) {
          meta(ctx.db, 'default_revision', refreshed.defaultRevision);
          meta(ctx.db, 'default_branch', refreshed.defaultBranch);
        }
        ctx.db.prepare(`
          INSERT INTO features(id, slug, title, outcome, status, priority, base_revision, branch, checkout_path, spec_revision, summary, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, slug, cleanTitle, cleanOutcome, priority, base, clone.branch, clone.destination, initialSpec ? 1 : 0, 'Feature lane created.', created, created);
        if (initialSpec) ctx.db.prepare('INSERT INTO spec_revisions(id, feature_id, revision, content, rationale, created_at) VALUES (?, ?, 1, ?, ?, ?)')
          .run(newId('spec'), id, initialSpec, 'Initial feature specification.', created);
      });
      const row = featureBySlug(ctx.db, slug);
      const specBody = initialSpec || `# ${cleanTitle}\n\n## Outcome\n\n${cleanOutcome}\n\n## User-visible behavior\n\n## Constraints and compatibility\n\n## Acceptance criteria\n\n## Out of scope\n\n## Open decisions\n`;
      await atomicWrite(root, contained(root, STATE_DIR, 'features', slug, 'spec.md'), `${specBody.trim()}\n`);
      const { author, committer, origin: identityOrigin, scope: identityScope, source: identitySource, overridden } = clone.commitIdentity;
      await addEvent(ctx, { featureId: id, kind: 'feature.created', summary: `Created ${slug} from ${base.slice(0, 12)}.`, details: { branch: clone.branch, checkout: clone.destination, baseFeature: baseSlug, baseRevision: base, commitIdentity: { author, committer, origin: identityOrigin, scope: identityScope, source: identitySource, overridden } } });
      await writeFeatureContext(ctx, featureBySlug(ctx.db, slug));
      await writeIndex(ctx);
      return {
        feature: summarizeFeature(ctx, row),
        baseFeature: baseSlug,
        repositoryProfile: profile,
        canonicalSource: { status: canonicalSource, defaultRevision: refreshed.defaultRevision, defaultBranch: refreshed.defaultBranch },
        commitIdentity: clone.commitIdentity,
        contextPath: contained(root, STATE_DIR, 'features', slug, 'context.md'),
        specPath: contained(root, STATE_DIR, 'features', slug, 'spec.md'),
        next: `${initialSpec ? 'Review the saved spec and plan work items.' : 'Develop the spec with the user, then save it with feature_update.'}${clone.commitIdentity.automation ? ' Disclose that this lane commits as the OVERDRIVE automation identity and show the optional lane-local override from commitIdentity.override; work and commits need not wait for an answer.' : clone.commitIdentity.overridden ? ' Disclose that inherited Git identity overrides decide this lane\'s author and committer (see commitIdentity).' : ''}`,
      };
    } finally { ctx.db.close(); }
  });
}

// A QA agent is a lane row of kind qa that works in the shared lab; its brief is its spec.
export async function createQaAgent({ workspace_path, name = 'qa', brief }) {
  const root = await resolveWorkspace(workspace_path);
  const slug = newAgentSlug(name, 'name');
  const cleanBrief = requiredText(brief, 'brief', { max: 500_000 });
  return await withWorkspaceLock(root, 'features', async () => {
    const ctx = await loadWorkspace(root);
    try {
      if (ctx.db.prepare('SELECT 1 FROM features WHERE slug = ?').get(slug)) throw new OverdriveError(`A lane or QA agent named ${slug} already exists.`, 'FEATURE_EXISTS');
      const lab = await ensureLab(root);
      const { head, branch } = await repositorySnapshot(lab);
      const id = newId('feature');
      const created = now();
      transaction(ctx.db, () => {
        ctx.db.prepare(`
          INSERT INTO features(id, slug, kind, title, outcome, status, base_revision, branch, checkout_path, spec_revision, summary, created_at, updated_at)
          VALUES (?, ?, 'qa', ?, ?, 'active', ?, ?, ?, 1, 'QA agent created.', ?, ?)
        `).run(id, slug, `QA: ${slug}`, 'Test the lanes and their integration in the lab, and report findings.', head, branch || 'main', lab, created, created);
        ctx.db.prepare('INSERT INTO spec_revisions(id, feature_id, revision, content, rationale, created_at) VALUES (?, ?, 1, ?, ?, ?)')
          .run(newId('spec'), id, cleanBrief, 'QA brief.', created);
      });
      const row = featureBySlug(ctx.db, slug);
      await addEvent(ctx, { featureId: id, kind: 'qa.created', summary: `Created QA agent ${slug} in the lab.`, details: { lab } });
      await writeFeatureContext(ctx, row);
      await writeIndex(ctx);
      return {
        agent: summarizeFeature(ctx, row),
        lab,
        contextPath: contained(root, STATE_DIR, 'features', slug, 'context.md'),
        specPath: contained(root, STATE_DIR, 'features', slug, 'spec.md'),
        next: `Start it with agent_start {"agent": "${slug}"}. Change its brief with feature_update {"feature": "${slug}", "spec": ...}.`,
      };
    } finally { ctx.db.close(); }
  });
}

function summarizeFeature(ctx, feature) {
  const spend = workerSpend(ctx.db, feature.id);
  return {
    slug: feature.slug,
    kind: feature.kind,
    title: feature.title,
    outcome: feature.outcome,
    status: feature.status,
    priority: feature.priority,
    progress: progressFor(ctx.db, feature.id),
    summary: feature.summary,
    nextAction: feature.next_action,
    blocker: feature.blocker || null,
    specRevision: feature.spec_revision,
    checkoutPath: feature.checkout_path,
    ...(feature.checkout_location?.bound === false ? { checkoutLocation: { bound: false, reason: feature.checkout_location.reason, recordedPath: feature.checkout_location.recorded } } : {}),
    branch: feature.branch,
    baseRevision: feature.base_revision,
    agent: {
      status: feature.agent_status,
      threadId: feature.thread_id ?? null,
      harness: feature.thread_id ? feature.thread_harness ?? 'unknown' : null,
      activeTurnId: feature.active_turn_id ?? null,
    },
    ...(spend ? { spend } : {}),
  };
}

const MESSAGE_PAGE_SIZE = 10;

// Checked before the workspace is read, so a refused call delivers nothing.
function coordinatorMessageMode(mode = 'pending', before) {
  if (mode !== 'pending' && mode !== 'recent') throw new OverdriveError('coordinator_messages must be pending or recent.', 'INVALID_INPUT');
  if (before === undefined) return { mode, before: null };
  if (mode !== 'recent') throw new OverdriveError('before_message pages message history; pass it with coordinator_messages: recent.', 'INVALID_INPUT');
  if (!Number.isSafeInteger(before) || before < 1) throw new OverdriveError('before_message must be a positive integer message id.', 'INVALID_INPUT');
  return { mode, before };
}

// The coordinator's messages newest first, pending and delivered alike; reading them delivers none.
function coordinatorMessageHistory(db, before) {
  const rows = db.prepare("SELECT id, from_agent, body, status, created_at, delivered_at, delivered_how FROM messages WHERE to_agent = 'coordinator' AND id < ? ORDER BY id DESC LIMIT ?")
    .all(before ?? Number.MAX_SAFE_INTEGER, MESSAGE_PAGE_SIZE + 1);
  const messageHistory = rows.slice(0, MESSAGE_PAGE_SIZE).map(row => ({
    id: row.id, from: row.from_agent, body: redactString(row.body), createdAt: row.created_at,
    status: row.status, deliveredAt: row.delivered_at, deliveredHow: row.delivered_how,
  }));
  return { messageHistory, nextBeforeMessage: rows.length > MESSAGE_PAGE_SIZE ? messageHistory.at(-1).id : null };
}

export async function listFeatures({ workspace_path, include_archived = false, refresh_git = false, coordinator_messages, before_message }) {
  const messages = coordinatorMessageMode(coordinator_messages, before_message);
  return await withContext(workspace_path, async ctx => {
    const features = [];
    const openFindings = ctx.db.prepare(OPEN_FINDING_COUNT);
    const latestRun = ctx.db.prepare('SELECT id, suite, status, revision, created_at FROM lab_runs WHERE target = ? AND mutant IS NULL ORDER BY created_at DESC LIMIT 1');
    for (const feature of listFeatureRows(ctx.db, { includeArchived: Boolean(include_archived) })) {
      const result = {
        ...summarizeFeature(ctx, recoverAgentState(ctx, feature)),
        openFindings: Number(openFindings.get(feature.slug).count),
        latestLabRun: latestRun.get(feature.slug) ?? null,
      };
      if (refresh_git) {
        try { result.git = await repositorySnapshot(assertBoundCheckout(feature).checkout_path, feature.base_revision); }
        catch (error) { result.git = { error: error.message }; }
      }
      features.push(result);
    }
    const spend = workerSpend(ctx.db);
    const workspace = { ...overview(ctx), ...(spend ? { spend } : {}) };
    if (messages.mode === 'recent') return { workspace, features, ...coordinatorMessageHistory(ctx.db, messages.before) };
    return { workspace, features, coordinatorMessages: takeCoordinatorRows(ctx.db, 'list') };
  });
}

// The capability profile of a worker-mode caller, read from its recorded row.
export async function agentProfile({ workspace_path, agent }) {
  return await withContext(workspace_path, ctx => workerProfile(readFeatureRow(ctx.db, safeSlug(agent, 'agent'))));
}

// The coordinator is only ever a sender through the runtime; worker identities are slugs.
export async function sendAgentMessage({ workspace_path, from, to, message }) {
  const sender = from === 'coordinator' ? from : safeSlug(from, 'from');
  const recipient = to === 'coordinator' ? to : safeSlug(to, 'to');
  if (sender === recipient) throw new OverdriveError('An agent cannot message itself.', 'INVALID_INPUT');
  const text = redactString(requiredText(message, 'message', { max: 20_000 }));
  return await withContext(workspace_path, ctx => {
    if (recipient !== 'coordinator') readFeatureRow(ctx.db, recipient);
    const createdAt = now();
    const { lastInsertRowid } = ctx.db.prepare("INSERT INTO messages(from_agent, to_agent, body, status, created_at) VALUES (?, ?, ?, 'pending', ?)").run(sender, recipient, text, createdAt);
    return { sent: true, id: Number(lastInsertRowid), from: sender, to: recipient, createdAt };
  });
}

// Agents with pending messages that this controller can deliver now: those whose turn runs in one
// of its sessions (threads), and idle agents with a spec that are not paused, done or archived.
// Others' messages wait.
export async function deliverableAgents({ workspace_path, threads, skip = [] }) {
  return await withContext(workspace_path, ctx => ctx.db.prepare(`SELECT DISTINCT to_agent FROM messages WHERE status = 'pending'
    AND to_agent NOT IN (SELECT value FROM json_each(?)) AND to_agent IN (
      SELECT slug FROM features WHERE spec_revision > 0 AND status NOT IN ('paused', 'done', 'archived') AND (
        (agent_status = 'running' AND thread_id IN (SELECT value FROM json_each(?)))
        OR NOT ${AGENT_BUSY_SQL}))`).all(JSON.stringify(skip), JSON.stringify(threads)).map(row => row.to_agent));
}

// The messages waiting for one agent, oldest first. Only a holder of the agent's control lock
// delivers them, so no other controller can deliver the same messages meanwhile.
export async function agentInbox({ workspace_path, feature }) {
  return await withContext(workspace_path, ctx => ctx.db.prepare("SELECT id, from_agent, body, created_at FROM messages WHERE to_agent = ? AND status = 'pending' ORDER BY id").all(safeSlug(feature)));
}

// Marks inbox messages delivered by how: 'steer' into a running turn, or 'prompt' of a new one.
export async function markDelivered({ workspace_path, feature, messages, how }) {
  if (!messages.length) return;
  await withContext(workspace_path, async ctx => {
    const ids = messages.map(message => message.id);
    const senders = ctx.db.prepare("UPDATE messages SET status = 'delivered', delivered_at = ?, delivered_how = ? WHERE status = 'pending' AND id IN (SELECT value FROM json_each(?)) RETURNING from_agent").all(now(), how, JSON.stringify(ids));
    if (!senders.length) return;
    const featureId = ctx.db.prepare('SELECT id FROM features WHERE slug = ?').get(feature)?.id ?? null;
    await addEvent(ctx, { featureId, kind: 'message.delivered', summary: `Delivered ${senders.length} message(s) from ${[...new Set(senders.map(row => row.from_agent))].join(', ')} by ${how}.`, details: { messages: ids, how } });
  });
}

// Returns the coordinator's pending messages, oldest first, and marks them delivered by how.
function takeCoordinatorRows(db, how) {
  return db.prepare("UPDATE messages SET status = 'delivered', delivered_at = ?, delivered_how = ? WHERE to_agent = 'coordinator' AND status = 'pending' RETURNING id, from_agent, body, created_at")
    .all(now(), how).sort((a, b) => a.id - b.id).map(row => ({ id: row.id, from: row.from_agent, body: row.body, createdAt: row.created_at }));
}

export async function takeCoordinatorMessages({ workspace_path }) {
  return await withContext(workspace_path, ctx => takeCoordinatorRows(ctx.db, 'wait'));
}

// One database handle for a wait that polls the coordinator's inbox; a failed read counts as empty.
export async function openCoordinatorInbox({ workspace_path }) {
  const ctx = await loadWorkspace(await resolveWorkspace(workspace_path));
  const pending = ctx.db.prepare("SELECT 1 FROM messages WHERE to_agent = 'coordinator' AND status = 'pending' LIMIT 1");
  return {
    waiting() {
      try { return Boolean(pending.get()); } catch { return false; }
    },
    close: () => closeContext(ctx),
  };
}

// Every lane and QA agent as other agents need to see it; archived rows are left out.
export async function listLanes({ workspace_path }) {
  return await withContext(workspace_path, async ctx => {
    const openFindings = ctx.db.prepare(OPEN_FINDING_COUNT);
    const lanes = [];
    for (const row of listFeatureRows(ctx.db)) {
      const git = await repositorySnapshot(row.checkout_path).catch(() => null);
      lanes.push({
        slug: row.slug, kind: row.kind, title: row.title, status: row.status, agentStatus: row.agent_status,
        checkoutPath: row.checkout_path, spec: contained(ctx.root, STATE_DIR, 'features', row.slug, 'spec.md'), head: git?.head ?? null, dirty: git ? !git.clean : null,
        openFindings: Number(openFindings.get(row.slug).count),
      });
    }
    return { lanes };
  });
}

// committed_changes adds a lane's committed footprint from its base to the captured HEAD; QA agents' lab has none.
export async function getFeatureContext({ workspace_path, feature, timeline_limit = 20, committed_changes = true }) {
  return await withContext(workspace_path, async ctx => {
    const row = recoverAgentState(ctx, featureBySlug(ctx.db, safeSlug(feature)));
    const projection = await writeFeatureContext(ctx, row);
    const { snapshot } = projection;
    const git = committed_changes && snapshot.head && workerProfile(row) !== 'qa'
      ? { ...snapshot, committedChanges: await committedChanges(row.checkout_path, row.base_revision, snapshot.head) }
      : snapshot;
    const spec = latestSpec(ctx.db, row.id);
    const timeline = timelineRows(ctx.db, row.id, timeline_limit);
    const summary = summarizeFeature(ctx, row);
    return {
      feature: { ...summary, agent: { ...summary.agent, usage: agentUsage(ctx.db, row) } },
      specification: spec ?? { revision: 0, content: await fs.readFile(contained(ctx.root, STATE_DIR, 'features', row.slug, 'spec.md'), 'utf8') },
      workItems: projection.work,
      evidence: projection.evidence,
      findings: projection.findings,
      labRuns: recentRuns(ctx.db, row, 5),
      messages: projection.messages,
      pendingAgentRequests: projection.pending,
      git,
      commitIdentity: projection.commitIdentity,
      timeline,
      contextPath: contained(ctx.root, STATE_DIR, 'features', row.slug, 'context.md'),
    };
  });
}

// The lane's recorded state and pending requests, without reading Git or rewriting its context packet.
export async function featureState({ workspace_path, feature }) {
  return await withContext(workspace_path, async ctx => {
    const row = recoverAgentState(ctx, featureBySlug(ctx.db, safeSlug(feature)));
    return { feature: summarizeFeature(ctx, row), pendingAgentRequests: pendingRows(ctx.db, row.id) };
  });
}

function workKey(value, name = 'work item key') {
  const key = requiredText(value, name, { max: 63 });
  if (!/^[A-Za-z][A-Za-z0-9._-]{0,62}$/.test(key)) throw new OverdriveError(`${name} has an invalid format.`, 'INVALID_WORK_KEY');
  return key;
}

// An omitted field stays unchanged; null or blank text clears it.
function editableText(value, name, max) {
  if (value === undefined) return undefined;
  return optionalText(value, name, { max }) ?? '';
}

function validateWorkGraph(db, featureId) {
  const items = workItems(db, featureId);
  const graph = new Map(items.map(item => [item.item_key, item.dependencies]));
  const visiting = new Set();
  const visited = new Set();
  function visit(key, chain = []) {
    if (visiting.has(key)) throw new OverdriveError(`Work graph cycle: ${[...chain, key].join(' -> ')}`, 'WORK_GRAPH_CYCLE');
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dependency of graph.get(key) ?? []) {
      if (!graph.has(dependency)) throw new OverdriveError(`Unknown dependency ${dependency} for ${key}.`, 'UNKNOWN_DEPENDENCY');
      visit(dependency, [...chain, key]);
    }
    visiting.delete(key);
    visited.add(key);
  }
  for (const key of graph.keys()) visit(key);
}

// Planned and ready are derived from dependency completion; every other status is set explicitly.
function reconcileReady(db, featureId) {
  const items = workItems(db, featureId);
  const status = new Map(items.map(item => [item.item_key, item.status]));
  const statement = db.prepare('UPDATE work_items SET status = ?, updated_at = ? WHERE id = ?');
  for (const item of items) {
    if (!['planned', 'ready'].includes(item.status)) continue;
    const next = item.dependencies.every(key => status.get(key) === 'done') ? 'ready' : 'planned';
    if (next !== item.status) statement.run(next, now(), item.id);
  }
}

function workItemInput(item, index) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new OverdriveError(`items[${index}] must be an object.`, 'INVALID_INPUT');
  const key = workKey(item.key, `items[${index}].key`);
  if (item.kind !== undefined && !WORK_KINDS.has(item.kind)) throw new OverdriveError(`Unknown work kind: ${item.kind}`, 'INVALID_INPUT');
  if (item.status !== undefined && !WORK_STATUSES.has(item.status)) throw new OverdriveError(`Unknown work status: ${item.status}`, 'INVALID_INPUT');
  if (item.depends_on !== undefined && (!Array.isArray(item.depends_on) || item.depends_on.length > 100)) throw new OverdriveError(`Invalid depends_on for ${key}.`, 'INVALID_INPUT');
  return {
    key,
    title: item.title === undefined ? undefined : requiredText(item.title, `${key}.title`, { max: 500 }),
    description: editableText(item.description, `${key}.description`, 50_000),
    acceptance: editableText(item.acceptance, `${key}.acceptance`, 50_000),
    kind: item.kind,
    status: item.status,
    result: editableText(item.result, `${key}.result`, 50_000),
    blocker: editableText(item.blocker, `${key}.blocker`, 20_000),
    dependsOn: item.depends_on && [...new Set(item.depends_on.map(dep => workKey(dep, `${key}.depends_on`)))],
  };
}

export async function updateWork({ workspace_path, feature, items = [], remove = [] }) {
  if (!Array.isArray(items) || items.length > 200) throw new OverdriveError('items must contain at most 200 work items.', 'INVALID_INPUT');
  if (!Array.isArray(remove) || remove.length > 200) throw new OverdriveError('remove must contain at most 200 work keys.', 'INVALID_INPUT');
  const normalized = items.map(workItemInput);
  const removed = new Set(remove.map((key, index) => workKey(key, `remove[${index}]`)));
  const keys = new Set(normalized.map(item => item.key));
  if (keys.size !== normalized.length) throw new OverdriveError('Work item keys must be unique in one call.', 'INVALID_INPUT');
  if (!keys.size && !removed.size) throw new OverdriveError('Submit work items or keys to remove.', 'INVALID_INPUT');
  if ([...removed].some(key => keys.has(key))) throw new OverdriveError('A work item cannot be updated and removed in one call.', 'INVALID_INPUT');
  const root = await resolveWorkspace(workspace_path);
  const slug = safeSlug(feature);
  return await withWorkspaceLock(root, 'features', async () => {
    const ctx = await loadWorkspace(root);
    try {
      const row = featureBySlug(ctx.db, slug);
      const stamp = now();
      transaction(ctx.db, () => {
        const existing = new Map(workItems(ctx.db, row.id).map(item => [item.item_key, item]));
        for (const key of removed) if (!existing.has(key)) throw new OverdriveError(`Unknown work item: ${key}`, 'WORK_ITEM_NOT_FOUND');
        const ids = new Map([...existing].map(([key, item]) => [key, item.id]));
        for (const item of normalized) {
          const found = existing.get(item.key);
          if (!found && item.title === undefined) throw new OverdriveError(`${item.key}.title is required for a new work item.`, 'INVALID_INPUT');
          const values = [
            item.title ?? found.title, item.description ?? found?.description ?? '', item.kind ?? found?.kind ?? 'build',
            item.status ?? found?.status ?? 'planned', item.acceptance ?? found?.acceptance ?? '', item.result ?? found?.result_summary ?? '',
            item.blocker ?? found?.blocker ?? '', stamp,
          ];
          if (found) {
            ctx.db.prepare('UPDATE work_items SET title = ?, description = ?, kind = ?, status = ?, acceptance = ?, result_summary = ?, blocker = ?, updated_at = ? WHERE id = ?').run(...values, found.id);
          } else {
            const id = newId('work');
            ctx.db.prepare('INSERT INTO work_items(title, description, kind, status, acceptance, result_summary, blocker, updated_at, id, feature_id, item_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(...values, id, row.id, item.key, stamp);
            ids.set(item.key, id);
          }
        }
        for (const item of normalized.filter(item => item.dependsOn)) {
          ctx.db.prepare('DELETE FROM work_dependencies WHERE work_item_id = ?').run(ids.get(item.key));
          for (const dependency of item.dependsOn) {
            if (!ids.has(dependency)) throw new OverdriveError(`Unknown dependency ${dependency} for ${item.key}.`, 'UNKNOWN_DEPENDENCY');
            ctx.db.prepare('INSERT INTO work_dependencies(work_item_id, depends_on_id) VALUES (?, ?)').run(ids.get(item.key), ids.get(dependency));
          }
        }
        // Removal would silently drop the edges of work that still depends on the removed item.
        const dependent = workItems(ctx.db, row.id).find(item => !removed.has(item.item_key) && item.dependencies.some(key => removed.has(key)));
        if (dependent) throw new OverdriveError(`${dependent.item_key} still depends on removed work.`, 'UNKNOWN_DEPENDENCY');
        for (const key of removed) ctx.db.prepare('DELETE FROM work_items WHERE id = ?').run(ids.get(key));
        validateWorkGraph(ctx.db, row.id);
        reconcileReady(ctx.db, row.id);
        ctx.db.prepare('UPDATE features SET updated_at = ? WHERE id = ?').run(stamp, row.id);
      });
      await addEvent(ctx, { featureId: row.id, kind: 'work.updated', summary: `Updated ${keys.size} work item(s)${removed.size ? ` and removed ${removed.size}` : ''}.`, details: { keys: [...keys], removed: [...removed] } });
      const current = featureBySlug(ctx.db, slug);
      await writeFeatureContext(ctx, current);
      await writeIndex(ctx);
      return { feature: summarizeFeature(ctx, current), workItems: workItems(ctx.db, row.id).filter(item => keys.has(item.item_key)) };
    } finally { ctx.db.close(); }
  });
}

function cleanStringArray(value, name, max = 100) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max) throw new OverdriveError(`${name} must be an array with at most ${max} entries.`, 'INVALID_INPUT');
  return value.map((entry, index) => requiredText(entry, `${name}[${index}]`, { max: 20_000 }));
}

// Validates an update before anything acts on it, such as stopping a worker.
export function featureUpdateInput({ status, spec, spec_rationale, summary, next_action, blocker, unresolved }) {
  if (status !== undefined && !FEATURE_STATUSES.has(status)) throw new OverdriveError(`Unknown feature status: ${status}`, 'INVALID_INPUT');
  return {
    status,
    spec: spec === undefined ? undefined : requiredText(spec, 'spec', { max: 500_000 }),
    rationale: optionalText(spec_rationale, 'spec_rationale', { max: 20_000 }) || '',
    summary: editableText(summary, 'summary', 50_000),
    nextAction: editableText(next_action, 'next_action', 20_000),
    // A blocker describes the blocked state, so another status given without one clears it.
    blocker: editableText(blocker, 'blocker', 20_000) ?? (status !== undefined && status !== 'blocked' ? '' : undefined),
    unresolved: unresolved === undefined ? undefined : cleanStringArray(unresolved, 'unresolved'),
  };
}

export async function updateFeature(args) {
  const input = featureUpdateInput(args);
  const root = await resolveWorkspace(args.workspace_path);
  return await withWorkspaceLock(root, 'features', () => applyFeatureUpdate(root, safeSlug(args.feature), input));
}

// Records an update for a caller that already holds the lane's control lock and has stopped its
// worker. The write itself refuses a lane whose worker may still be live, so a pause or archive
// can never claim a stop that did not happen.
export async function updateStoppedFeature(args) {
  const input = featureUpdateInput(args);
  const root = await resolveWorkspace(args.workspace_path);
  return await withWorkspaceLock(root, 'features', () => applyFeatureUpdate(root, safeSlug(args.feature), input, { requireStopped: true }));
}

async function applyFeatureUpdate(root, slug, { status, spec, rationale, summary, nextAction, blocker, unresolved }, { requireStopped = false } = {}) {
  const ctx = await loadWorkspace(root);
  try {
    const row = featureBySlug(ctx.db, slug);
    const previousSpec = latestSpec(ctx.db, row.id)?.content || '';
    const specChanged = spec !== undefined && previousSpec.trim() !== spec;
    const revision = row.spec_revision + (specChanged ? 1 : 0);
    const stamp = now();
    transaction(ctx.db, () => {
      if (specChanged) ctx.db.prepare('INSERT INTO spec_revisions(id, feature_id, revision, content, rationale, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(newId('spec'), row.id, revision, spec, rationale, stamp);
      const stopped = requireStopped ? ` AND NOT ${AGENT_BUSY_SQL} AND ${DESCENDANTS_CLEAR_SQL} AND ${WORKERS_CLEAR_SQL}` : '';
      const changed = ctx.db.prepare(`UPDATE features SET status = COALESCE(?, status), spec_revision = ?, summary = COALESCE(?, summary), next_action = COALESCE(?, next_action), blocker = COALESCE(?, blocker), updated_at = ? WHERE id = ?${stopped}`)
        .run(status ?? null, revision, summary ?? null, nextAction ?? null, blocker ?? null, stamp, row.id);
      if (!changed.changes) throw new OverdriveError(`The ${slug} worker may still be running, so the lane was not marked ${status}.`, 'STOP_UNCONFIRMED');
    });
    let specResult;
    if (specChanged) {
      const diff = lineDiff(previousSpec, spec);
      specResult = { revision, diff, specPath: contained(root, STATE_DIR, 'features', slug, 'spec.md') };
      await addEvent(ctx, { featureId: row.id, kind: 'spec.revised', summary: `Saved spec revision ${revision} (+${diff.added}/-${diff.removed} logical lines).`, details: { revision, rationale } });
    }
    const statusChanged = status !== undefined && status !== row.status;
    const notes = Object.fromEntries(Object.entries({ summary, nextAction, blocker, unresolved }).filter(([, value]) => value !== undefined));
    if (statusChanged || Object.keys(notes).length) {
      await addEvent(ctx, { featureId: row.id, kind: statusChanged ? `feature.${status}` : 'feature.updated', summary: summary || blocker || (statusChanged ? `Feature marked ${status}.` : 'Feature notes updated.'), details: notes });
    }
    const current = featureBySlug(ctx.db, slug);
    await writeFeatureContext(ctx, current);
    await writeIndex(ctx);
    const agent = { status: current.agent_status, activeTurnId: current.active_turn_id ?? null };
    return { feature: { slug, status: current.status, specRevision: current.spec_revision, agent }, ...(specResult ? { spec: specResult } : {}) };
  } finally { ctx.db.close(); }
}

function timelineRows(db, featureId, limit = 30) {
  const bounded = Math.max(1, Math.min(Number(limit) || 30, 200));
  return db.prepare('SELECT id, kind, summary, details_json, created_at FROM events WHERE feature_id = ? ORDER BY id DESC LIMIT ?').all(featureId, bounded)
    .map(row => ({ id: Number(row.id), kind: row.kind, summary: row.summary, details: parseJson(row.details_json, {}), createdAt: row.created_at }));
}

// A QA agent also reaches every lane checkout and the runtime's lab clones, runs and artifacts.
async function qaRoots(ctx) {
  const labState = await ensureManagedPath(ctx.root, contained(ctx.root, STATE_DIR, 'lab'));
  await fs.mkdir(labState, { recursive: true });
  const lanes = listFeatureRows(ctx.db).filter(lane => lane.kind !== 'qa' && lane.checkout_location?.bound);
  return [...lanes.map(lane => lane.checkout_path), labState];
}

// Without refresh_context the context packet, which reads Git, is left for a later writer such as getFeatureContext.
export async function featureRuntime({ workspace_path, feature, allow_inactive = false, force_new_session = false, refresh_context = true }) {
  return await withContext(workspace_path, async ctx => {
    const row = recoverAgentState(ctx, featureBySlug(ctx.db, safeSlug(feature)));
    if (!allow_inactive && ['paused', 'done', 'archived'].includes(row.status)) throw new OverdriveError(`Feature ${row.slug} is ${row.status}; resume or reactivate it before starting work.`, 'INVALID_TRANSITION');
    const packet = refresh_context ? await writeFeatureContext(ctx, row) : { work: workItems(ctx.db, row.id) };
    // Older workspaces kept a copy of the contract above the checkout, where Claude Code would still load it.
    await fs.rm(contained(ctx.root, 'features', row.slug, 'AGENTS.md'), { force: true });
    const contextPath = contained(ctx.root, STATE_DIR, 'features', row.slug, 'context.md');
    const profile = workerProfile(row);
    return {
      root: ctx.root,
      feature: row,
      profile,
      cwd: row.checkout_path,
      roots: [row.checkout_path, ...(profile === 'qa' ? await qaRoots(ctx) : []), path.dirname(contextPath)],
      // Where the agent's file tools may write: its own checkout, and for QA the integration clone too.
      writeRoots: [row.checkout_path, ...(profile === 'qa' ? [integrationPath(ctx.root)] : [])],
      contextPath,
      specPath: contained(ctx.root, STATE_DIR, 'features', row.slug, 'spec.md'),
      work: packet.work,
      developerInstructions: agentInstructions(ctx.root, row),
      ...sessionHarness(ctx.config, row, force_new_session),
    };
  });
}

// Binds the lane to a session it just created, recording the owning harness. The replaced
// binding is kept in the timeline so its conversation stays reachable in its own backend.
export async function bindAgentSession({ workspace_path, feature, thread_id, harness, expected_thread_id = null, owner_token }) {
  if (!HARNESSES.has(harness)) throw new OverdriveError('A native session must record its owning harness.', 'SESSION_OWNER_UNKNOWN');
  const root = await resolveWorkspace(workspace_path);
  const slug = safeSlug(feature);
  return await withWorkspaceLock(root, 'agent-state', async () => {
    const ctx = await loadWorkspace(root);
    try {
      const row = featureBySlug(ctx.db, slug);
      if (!ownsAgent(ctx.db, row.id, owner_token)) throw new OverdriveError('Another controller took this lane before its new session could be saved.', 'AGENT_OWNED');
      if ((row.thread_id ?? null) !== expected_thread_id || row.active_turn_id) throw new OverdriveError('The lane session changed before its replacement could be saved; inspect it and retry.', 'SESSION_CHANGED');
      const stamp = now();
      transaction(ctx.db, () => {
        ctx.db.prepare(`UPDATE features SET thread_id = ?, thread_harness = ?, active_turn_id = NULL, agent_status = 'starting', updated_at = ? WHERE id = ?`)
          .run(thread_id, harness, stamp, row.id);
        if (row.thread_id) ctx.db.prepare("UPDATE pending_agent_requests SET status = 'orphaned', resolved_at = ? WHERE feature_id = ? AND thread_id = ? AND status = 'pending'").run(stamp, row.id, row.thread_id);
      });
      if (row.thread_id) await addEvent(ctx, { featureId: row.id, kind: 'agent.session_replaced', summary: `Replaced native session ${row.thread_id} (${row.thread_harness ?? 'backend unknown'}) with ${thread_id} (${harness}). The previous conversation remains in its own backend.`, details: { previousThreadId: row.thread_id, previousHarness: row.thread_harness ?? null, threadId: thread_id, harness } });
      await writeFeatureContext(ctx, featureBySlug(ctx.db, slug));
      await writeIndex(ctx);
      return summarizeFeature(ctx, featureBySlug(ctx.db, slug));
    } finally { ctx.db.close(); }
  });
}

// Undoes bindAgentSession when the new session never started a turn, restoring the previous
// binding (or none) so a failed replacement cannot strand the lane on an unusable session.
export async function releaseAgentSession({ workspace_path, feature, thread_id, previous_thread_id = null, previous_harness = null, summary, owner_token }) {
  const root = await resolveWorkspace(workspace_path);
  const slug = safeSlug(feature);
  return await withWorkspaceLock(root, 'agent-state', async () => {
    const ctx = await loadWorkspace(root);
    try {
      const row = featureBySlug(ctx.db, slug);
      if (!ownsAgent(ctx.db, row.id, owner_token) || row.thread_id !== thread_id || row.active_turn_id || row.agent_status !== 'starting') return { ignored: true };
      const cleanSummary = requiredText(summary, 'summary', { max: 100_000 });
      ctx.db.prepare(`UPDATE features SET thread_id = ?, thread_harness = ?, agent_status = 'failed', summary = ?, updated_at = ? WHERE id = ?`)
        .run(previous_thread_id, previous_thread_id ? previous_harness : null, cleanSummary, now(), row.id);
      await addEvent(ctx, { featureId: row.id, kind: 'agent.failed', summary: cleanSummary, details: { threadId: thread_id, restoredThreadId: previous_thread_id, restoredHarness: previous_thread_id ? previous_harness : null } });
      await writeFeatureContext(ctx, featureBySlug(ctx.db, slug));
      await writeIndex(ctx);
      return summarizeFeature(ctx, featureBySlug(ctx.db, slug));
    } finally { ctx.db.close(); }
  });
}

// Session state changes only for the session the lane is bound to, so late events from a
// replaced session cannot mutate its replacement. New sessions are bound by bindAgentSession.
export async function saveAgentSession({ workspace_path, feature, thread_id, turn_id = null, status, summary = undefined, owner_token, only_if_status = null, orphan_requests = false }) {
  const root = await resolveWorkspace(workspace_path);
  const slug = safeSlug(feature);
  return await withWorkspaceLock(root, 'agent-state', async () => {
    const ctx = await loadWorkspace(root);
    try {
      const row = featureBySlug(ctx.db, slug);
      if (row.thread_id !== thread_id || !ownsAgent(ctx.db, row.id, owner_token) || (only_if_status && row.agent_status !== only_if_status)) return { ignored: true };
      const cleanSummary = summary ? requiredText(summary, 'summary', { max: 100_000 }) : undefined;
      const stamp = now();
      transaction(ctx.db, () => {
        ctx.db.prepare(`UPDATE features SET active_turn_id = ?, agent_status = ?, summary = COALESCE(?, summary), updated_at = ? WHERE id = ?`)
          .run(turn_id, status, cleanSummary ?? null, stamp, row.id);
        if (status === 'disconnected' || orphan_requests) {
          ctx.db.prepare("UPDATE pending_agent_requests SET status = 'orphaned', resolved_at = ? WHERE feature_id = ? AND thread_id = ? AND status = 'pending'").run(stamp, row.id, thread_id);
        }
      });
      if (cleanSummary) await addEvent(ctx, { featureId: row.id, kind: `agent.${status}`, summary: cleanSummary, details: { threadId: thread_id, turnId: turn_id } });
      await writeFeatureContext(ctx, featureBySlug(ctx.db, slug));
      await writeIndex(ctx);
      return summarizeFeature(ctx, featureBySlug(ctx.db, slug));
    } finally { ctx.db.close(); }
  });
}

// Usage is written like session state: only by the lane's owner, for the session it is bound to.
async function withBoundSession({ workspace_path, feature, thread_id, owner_token }, write) {
  const root = await resolveWorkspace(workspace_path);
  const slug = safeSlug(feature);
  return await withWorkspaceLock(root, 'agent-state', async () => {
    const ctx = await loadWorkspace(root);
    try {
      const row = featureBySlug(ctx.db, slug);
      if (!ownsAgent(ctx.db, row.id, owner_token) || row.thread_id !== thread_id || !HARNESSES.has(row.thread_harness)) return { ignored: true };
      return transaction(ctx.db, () => write(ctx.db, { featureId: row.id, threadId: row.thread_id, harness: row.thread_harness, activeTurnId: row.active_turn_id ?? null })) ?? {};
    } finally { ctx.db.close(); }
  });
}

// fresh: the session was created for this turn.
export const startAgentTurnUsage = ({ turn_id, fresh = false, ...args }) => withBoundSession(args, (db, lane) => startTurnUsage(db, { ...lane, turnId: turn_id, fresh }));
export const recordAgentUsage = ({ turn_id, totals = null, main_loop = undefined, session_totals = null, ...args }) => withBoundSession(args, (db, lane) => recordTurnUsage(db, { ...lane, turnId: turn_id, totals, mainLoop: main_loop, sessionTotals: session_totals }));
export const endAgentTurnUsage = ({ turn_id, ended, final = false, ...args }) => withBoundSession(args, (db, lane) => endTurnUsage(db, { ...lane, turnId: turn_id, ended, final }));

export async function recordAgentEvent({ workspace_path, feature, kind, summary, details = {}, owner_token, thread_id = undefined }) {
  const root = await resolveWorkspace(workspace_path);
  const slug = safeSlug(feature);
  return await withWorkspaceLock(root, 'agent-state', async () => {
    const ctx = await loadWorkspace(root);
    try {
      const row = featureBySlug(ctx.db, slug);
      if (!ownsAgent(ctx.db, row.id, owner_token) || (thread_id !== undefined && row.thread_id !== thread_id)) return { ignored: true };
      const cleanSummary = requiredText(summary, 'summary', { max: 100_000 });
      return await addEvent(ctx, { featureId: row.id, kind, summary: cleanSummary, details });
    } finally { ctx.db.close(); }
  });
}

// Records that a worker process of the bound session was stopped without its process tree, so
// tools it launched may still be running. Guarded like other session writes. Every occurrence
// gets a new generation, so an attestation about an earlier one cannot cover it; the same turn
// reported twice (by its interrupt and by its completion) is one occurrence.
const attestedDescendantsKey = (featureId, threadId, turnId) => `agent-descendants-attested:${featureId}:${threadId}:${turnId}`;

export async function markDescendantsUnconfirmed({ workspace_path, feature, thread_id, turn_id = null, summary, owner_token }) {
  const root = await resolveWorkspace(workspace_path);
  const slug = safeSlug(feature);
  return await withWorkspaceLock(root, 'agent-state', async () => {
    const ctx = await loadWorkspace(root);
    try {
      const row = featureBySlug(ctx.db, slug);
      if (!ownsAgent(ctx.db, row.id, owner_token) || row.thread_id !== thread_id) return { ignored: true };
      // A completion delivered after attestation must not recreate the marker it cleared.
      if (turn_id && meta(ctx.db, attestedDescendantsKey(row.id, thread_id, turn_id))) return { recorded: false, attested: true };
      const previous = unconfirmedDescendants(ctx.db, row.id);
      if (turn_id && previous?.threadId === thread_id && previous?.turnId === turn_id) return { recorded: false, generation: previous.generation };
      const cleanSummary = requiredText(summary, 'summary', { max: 20_000 });
      const generation = randomUUID();
      meta(ctx.db, descendantsKey(row.id), JSON.stringify({ generation, occurrences: (previous?.occurrences ?? 0) + 1, threadId: thread_id, turnId: turn_id, summary: cleanSummary, at: now() }));
      await addEvent(ctx, { featureId: row.id, kind: 'agent.descendants_unconfirmed', summary: cleanSummary, details: { threadId: thread_id, turnId: turn_id, generation } });
      return { recorded: true, generation };
    } finally { ctx.db.close(); }
  });
}

export async function readUnconfirmedDescendants({ workspace_path, feature }) {
  return await withContext(workspace_path, async ctx => unconfirmedDescendants(ctx.db, featureBySlug(ctx.db, safeSlug(feature)).id));
}

// Registered before a Claude turn request can reach its worker. A controller restart loses the
// process handle, so this record remains until its owning bridge confirms the worker's whole
// process tree ended or was stopped, a later controller finds its recorded containment job gone,
// or the coordinator attests it has stopped.
export async function registerWorkerGuard({ workspace_path, feature, thread_id, guard_id, owner_token }) {
  const root = await resolveWorkspace(workspace_path);
  const slug = safeSlug(feature);
  return await withWorkspaceLock(root, 'agent-state', async () => {
    const ctx = await loadWorkspace(root);
    try {
      const row = featureBySlug(ctx.db, slug);
      if (!ownsAgent(ctx.db, row.id, owner_token) || row.thread_id !== thread_id) return { ignored: true };
      const guards = parseJson(meta(ctx.db, workersKey(row.id)), []);
      if (!guards.some(guard => guard.id === guard_id)) guards.push({ id: guard_id, threadId: thread_id });
      meta(ctx.db, workersKey(row.id), JSON.stringify(guards));
      return { registered: true };
    } finally { ctx.db.close(); }
  });
}

// Records the containment job a Claude worker's process tree runs in, once the tree is inside it,
// so a later controller can prove from the job's absence that every process in it has ended.
export async function recordWorkerGuardJob({ workspace_path, feature, thread_id, guard_id, job, owner_token }) {
  const root = await resolveWorkspace(workspace_path);
  const slug = safeSlug(feature);
  return await withWorkspaceLock(root, 'agent-state', async () => {
    const ctx = await loadWorkspace(root);
    try {
      const row = featureBySlug(ctx.db, slug);
      if (!ownsAgent(ctx.db, row.id, owner_token) || row.thread_id !== thread_id) return { ignored: true };
      const guards = parseJson(meta(ctx.db, workersKey(row.id)), []);
      const guard = guards.find(entry => entry.id === guard_id);
      if (!guard) return { recorded: false };
      guard.job = requiredText(job, 'job', { max: 200 });
      meta(ctx.db, workersKey(row.id), JSON.stringify(guards));
      return { recorded: true };
    } finally { ctx.db.close(); }
  });
}

export async function readWorkerGuards({ workspace_path, feature }) {
  return await withContext(workspace_path, async ctx => parseJson(meta(ctx.db, workersKey(featureBySlug(ctx.db, safeSlug(feature)).id)), []));
}

// job_gone: the caller verified the guard's containment job no longer exists or holds no process.
// unused: the turn request the guard was registered for was refused before any worker started.
export async function clearWorkerGuards({ workspace_path, feature, guard_id = null, evidence = null, job_gone = false, unused = false }) {
  const root = await resolveWorkspace(workspace_path);
  const slug = safeSlug(feature);
  return await withWorkspaceLock(root, 'agent-state', async () => {
    const ctx = await loadWorkspace(root);
    try {
      const row = featureBySlug(ctx.db, slug);
      const guards = parseJson(meta(ctx.db, workersKey(row.id)), []);
      const remaining = guard_id ? guards.filter(guard => guard.id !== guard_id) : [];
      if (remaining.length === guards.length) return { cleared: false };
      transaction(ctx.db, () => {
        if (remaining.length) meta(ctx.db, workersKey(row.id), JSON.stringify(remaining));
        else ctx.db.prepare('DELETE FROM meta WHERE key = ?').run(workersKey(row.id));
      });
      const summary = evidence ? `The coordinator attested that no worker or tool process for this lane is running: ${evidence}`
        : job_gone ? 'The worker\'s process-tree job no longer exists or holds no process, so every process launched under it has ended.'
          : unused ? 'The turn request was refused before any worker process started.'
            : 'The owning bridge confirmed the worker and every process it launched stopped.';
      const basis = job_gone ? 'job_gone' : unused ? 'refused_request' : null;
      await addEvent(ctx, { featureId: row.id, kind: evidence ? 'agent.workers_attested' : 'agent.worker_stopped', summary, details: { guardId: guard_id, cleared: guards.length - remaining.length, ...(basis ? { basis } : {}) } });
      return { cleared: true };
    } finally { ctx.db.close(); }
  });
}

// Clears the unconfirmed-descendants marker on the coordinator's evidence that none is running,
// only if it is still the generation the evidence was given for.
export async function attestDescendantsStopped({ workspace_path, feature, evidence, generation }) {
  const root = await resolveWorkspace(workspace_path);
  const slug = safeSlug(feature);
  return await withWorkspaceLock(root, 'agent-state', async () => {
    const ctx = await loadWorkspace(root);
    try {
      const row = featureBySlug(ctx.db, slug);
      const marker = unconfirmedDescendants(ctx.db, row.id);
      if (!marker) return { cleared: false };
      if (marker.generation !== generation) return { cleared: false, stale: true };
      transaction(ctx.db, () => {
        if (marker.turnId) meta(ctx.db, attestedDescendantsKey(row.id, marker.threadId, marker.turnId), marker.generation);
        ctx.db.prepare('DELETE FROM meta WHERE key = ?').run(descendantsKey(row.id));
      });
      await addEvent(ctx, { featureId: row.id, kind: 'agent.descendants_attested', summary: `The coordinator attested that no process launched by the stopped worker is running: ${evidence}`, details: { basis: 'coordinator_attestation', marker } });
      return { cleared: true };
    } finally { ctx.db.close(); }
  });
}

export async function savePendingAgentRequest({ workspace_path, feature, request_id, thread_id, turn_id, method, summary, payload, owner_token }) {
  const root = await resolveWorkspace(workspace_path);
  const slug = safeSlug(feature);
  return await withWorkspaceLock(root, 'agent-state', async () => {
    const ctx = await loadWorkspace(root);
    try {
      const row = featureBySlug(ctx.db, slug);
      // A controller may only raise requests from the session the lane is currently bound to.
      if (!ownsAgent(ctx.db, row.id, owner_token) || (owner_token && row.thread_id !== thread_id)) return { ignored: true };
      const stamp = now();
      ctx.db.prepare(`INSERT OR REPLACE INTO pending_agent_requests(request_id, feature_id, thread_id, turn_id, method, summary, payload_json, status, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`)
        .run(String(request_id), row.id, thread_id, turn_id ?? null, method, summary, JSON.stringify(payload ?? {}), stamp);
      ctx.db.prepare("UPDATE features SET agent_status = 'waiting_for_user', updated_at = ? WHERE id = ?").run(stamp, row.id);
      await addEvent(ctx, { featureId: row.id, kind: 'agent.input_required', summary, details: { requestId: String(request_id), method } });
      await writeFeatureContext(ctx, featureBySlug(ctx.db, slug));
      await writeIndex(ctx);
      return { requestId: String(request_id), feature: slug };
    } finally { ctx.db.close(); }
  });
}

export async function pendingAgentRequest({ workspace_path, feature, request_id }) {
  return await withContext(workspace_path, async ctx => {
    const row = featureBySlug(ctx.db, safeSlug(feature));
    const request = ctx.db.prepare("SELECT * FROM pending_agent_requests WHERE feature_id = ? AND request_id = ? AND status = 'pending'").get(row.id, String(request_id));
    if (!request) throw new OverdriveError(`No pending request ${request_id} for ${row.slug}.`, 'REQUEST_NOT_FOUND');
    return { ...request, payload: parseJson(request.payload_json, {}) };
  });
}

export async function resolveAgentRequestRecord({ workspace_path, feature, request_id, summary, status = 'resolved', owner_token, thread_id, ignore_missing = false }) {
  if (!['resolved', 'orphaned'].includes(status)) throw new OverdriveError('Request resolution status is invalid.', 'INVALID_INPUT');
  const root = await resolveWorkspace(workspace_path);
  const slug = safeSlug(feature);
  return await withWorkspaceLock(root, 'agent-state', async () => {
    const ctx = await loadWorkspace(root);
    try {
      const row = featureBySlug(ctx.db, slug);
      if (!ownsAgent(ctx.db, row.id, owner_token)) return { ignored: true };
      const result = ctx.db.prepare("UPDATE pending_agent_requests SET status = ?, resolved_at = ? WHERE feature_id = ? AND request_id = ? AND status = 'pending' AND (? IS NULL OR thread_id = ?)").run(status, now(), row.id, String(request_id), thread_id ?? null, thread_id ?? null);
      if (!result.changes && ignore_missing) return { ignored: true };
      if (!result.changes) throw new OverdriveError(`No pending request ${request_id} for ${slug}.`, 'REQUEST_NOT_FOUND');
      ctx.db.prepare(`UPDATE features SET agent_status = CASE
        WHEN active_turn_id IS NULL AND agent_status <> 'waiting_for_user' THEN agent_status
        WHEN EXISTS (SELECT 1 FROM pending_agent_requests WHERE feature_id = features.id AND status = 'pending') THEN 'waiting_for_user'
        WHEN active_turn_id IS NULL THEN 'idle' ELSE 'running' END, updated_at = ? WHERE id = ?`).run(now(), row.id);
      await addEvent(ctx, { featureId: row.id, kind: status === 'resolved' ? 'agent.input_resolved' : 'agent.input_orphaned', summary: requiredText(summary, 'summary', { max: 20_000 }), details: { requestId: String(request_id) } });
      await writeFeatureContext(ctx, featureBySlug(ctx.db, slug));
      await writeIndex(ctx);
      return { status };
    } finally { ctx.db.close(); }
  });
}
