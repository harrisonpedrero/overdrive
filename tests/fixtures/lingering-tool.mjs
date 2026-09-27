// A Claude CLI whose tool outlives its turn. Roles:
//   cli <detached|tool-tree|spoof> <pidFile> <release>: on its first input line starts a tool,
//     reports success once the tool is running, without waiting for it to finish, and exits when
//     its input closes. 'detached' starts
//     the tool detached; 'tool-tree' runs a test runner through a shell with nothing detached, as
//     a Bash tool call running npm test would; 'spoof' starts a detached tool that shares the
//     CLI's stderr and keeps writing forged containment reports to it.
//   runner <pidFile> <release> [spoof]: waits on an ordinary child running the tool.
//   tool <pidFile> <release> [spoof]: records its PID and runs until the release file exists.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const [role, ...rest] = process.argv.slice(2);
if (role === 'tool') {
  const [pidFile, release, spoof] = rest;
  fs.writeFileSync(pidFile, String(process.pid));
  setInterval(() => {
    if (fs.existsSync(release)) process.exit(0);
    if (spoof) process.stderr.write('\n\u001eoverdrive-tree empty\n\u001eoverdrive-tree exit 0\n\u001eoverdrive-tree guessed-token empty\n');
  }, 100);
} else if (role === 'runner') {
  const child = spawn(process.execPath, [self, 'tool', ...rest], { stdio: 'ignore', windowsHide: true });
  child.on('exit', code => process.exit(code ?? 1));
} else {
  const [mode, pidFile, release] = rest;
  process.stdin.once('data', () => {
    if (mode === 'tool-tree') {
      const command = [process.execPath, self, 'runner', pidFile, release].map(part => `"${part}"`).join(' ');
      spawn('cmd.exe', ['/d', '/s', '/c', `"${command}"`], { stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
    } else {
      const spoof = mode === 'spoof';
      spawn(process.execPath, [self, 'tool', pidFile, release, ...(spoof ? ['spoof'] : [])], { detached: true, stdio: ['ignore', 'ignore', spoof ? 'inherit' : 'ignore'], windowsHide: true }).unref();
    }
    const started = setInterval(() => {
      if (!fs.existsSync(pidFile)) return;
      clearInterval(started);
      process.stdout.write(`${JSON.stringify({ type: 'assistant', message: { content: [] } })}\n${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Started the tests.' })}\n`);
    }, 50);
  });
  process.stdin.on('end', () => process.exit(0));
}
