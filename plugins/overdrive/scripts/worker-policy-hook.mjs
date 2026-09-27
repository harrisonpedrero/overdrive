// Worker PreToolUse hook (argv: profile, then the agent's write roots): an allowed call gets no decision, so
// user permission rules still apply, and a denied or unvettable call exits 2, the only hook failure that blocks it.
const BLOCKED = 2;

function block(reason) {
  process.stderr.write(`${reason}\n`);
  process.exitCode = BLOCKED;
}

async function readInput() {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) text += chunk;
  return JSON.parse(text);
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

try {
  const { workerToolDecision } = await import('./worker-policy.mjs');
  const call = await readInput();
  if (typeof call?.tool_name !== 'string' || !call.tool_name.trim() || !isObject(call.tool_input)) block('OVERDRIVE worker policy received a malformed tool call, so it was blocked.');
  else {
    const decision = workerToolDecision(process.argv[2] === 'qa' ? 'qa' : 'feature', call.tool_name, call.tool_input, { writeRoots: process.argv.length > 3 ? process.argv.slice(3) : null });
    if (!decision.allow) block(decision.message);
  }
} catch {
  // The input is not echoed: it can hold file contents or secrets.
  block('OVERDRIVE worker policy could not check this tool call, so it was blocked.');
}
