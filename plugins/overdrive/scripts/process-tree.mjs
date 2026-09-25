import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

// On Windows the warden joins a kill-on-close Job Object before launching the CLI, keeping even
// detached tools inside the completion boundary. Other platforms fail closed because a detached
// child can leave its process group.

export const TREE_MARK = '\u001eoverdrive-tree ';
const MODES = new Set(['run', 'query', 'stop']);

const WARDEN_SOURCE = String.raw`
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class OverdriveTree {
  [StructLayout(LayoutKind.Sequential)] struct Basic { public long UserLimit, JobUserLimit; public uint Flags; public UIntPtr MinWs, MaxWs; public uint ProcessLimit; public UIntPtr Affinity; public uint Priority, Scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong A, B, C, D, E, F; }
  [StructLayout(LayoutKind.Sequential)] struct Extended { public Basic Basic; public Io Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory; }
  [StructLayout(LayoutKind.Sequential)] struct Accounting { public long User, Kernel, PeriodUser, PeriodKernel; public uint Faults, Total, Active, Terminated; }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref Extended info, uint size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out Accounting info, uint size, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern void ExitProcess(uint code);
  const int NotFound = 2, AlreadyExists = 183;
  const uint KillOnJobClose = 0x2000, Query = 0x0004, Terminate = 0x0008;

  static string token = "";
  static void Mark(string text) {
    byte[] bytes = Encoding.UTF8.GetBytes("\n\u001eoverdrive-tree " + token + " " + text.Replace('\r', ' ').Replace('\n', ' ') + "\n");
    var stream = Console.OpenStandardError();
    stream.Write(bytes, 0, bytes.Length);
    stream.Flush();
  }
  static uint Active(IntPtr job) {
    Accounting info;
    if (!QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)) throw new Win32Exception();
    return info.Active;
  }
  // The inverse of CommandLineToArgvW, as libuv quotes arguments.
  static string Quote(string arg) {
    if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return arg;
    var quoted = new StringBuilder("\"");
    for (int i = 0; ; i++) {
      int slashes = 0;
      while (i < arg.Length && arg[i] == '\\') { slashes++; i++; }
      if (i == arg.Length) { quoted.Append('\\', slashes * 2); break; }
      if (arg[i] == '"') quoted.Append('\\', slashes * 2 + 1).Append('"');
      else quoted.Append('\\', slashes).Append(arg[i]);
    }
    return quoted.Append('"').ToString();
  }

  public static void Invoke(string mode, string name, string argv) {
    if (mode == "run") Run(name, argv);
    IntPtr job = OpenJobObject(Query | Terminate, false, name);
    if (job == IntPtr.Zero) {
      int error = Marshal.GetLastWin32Error();
      Console.Out.Write(error == NotFound ? "absent" : "unknown " + error);
      ExitProcess(error == NotFound ? 0u : 3u);
    }
    if (mode == "query") { Console.Out.Write("present " + Active(job)); ExitProcess(0); }
    if (mode != "stop") ExitProcess(6);
    if (!TerminateJobObject(job, 1)) ExitProcess(4);
    var clock = Stopwatch.StartNew();
    while (Active(job) > 0) { if (clock.ElapsedMilliseconds > 10000) ExitProcess(5); System.Threading.Thread.Sleep(25); }
    ExitProcess(0);
  }

  static void Run(string name, string argv) {
    IntPtr job;
    ProcessStartInfo start;
    token = Environment.GetEnvironmentVariable("OVERDRIVE_TREE_TOKEN") ?? "";
    try {
      string[] parts = argv.Split(',');
      var args = new string[parts.Length - 1];
      for (int i = 1; i < parts.Length; i++) args[i - 1] = Quote(Encoding.UTF8.GetString(Convert.FromBase64String(parts[i])));
      start = new ProcessStartInfo(Encoding.UTF8.GetString(Convert.FromBase64String(parts[0])), string.Join(" ", args));
      start.UseShellExecute = false;
      foreach (string key in new[] { "OVERDRIVE_TREE_MODE", "OVERDRIVE_TREE_JOB", "OVERDRIVE_TREE_ARGV", "OVERDRIVE_TREE_TOKEN" }) start.EnvironmentVariables.Remove(key);
      job = CreateJobObject(IntPtr.Zero, name);
      if (job == IntPtr.Zero) throw new Win32Exception();
      if (Marshal.GetLastWin32Error() == AlreadyExists) throw new Exception("job " + name + " already exists");
      var limits = new Extended();
      limits.Basic.Flags = KillOnJobClose;
      if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(Extended)))) throw new Win32Exception();
      if (!AssignProcessToJobObject(job, GetCurrentProcess())) throw new Win32Exception();
    } catch (Exception error) { Mark("unavailable " + error.Message); ExitProcess(3); return; }
    Process child;
    try { child = Process.Start(start); }
    catch (Exception error) { Mark("launch-failed " + error.Message); ExitProcess(2); return; }
    Mark("started " + child.Id);
    child.WaitForExit();
    uint code = (uint)child.ExitCode;
    Mark("exit " + code);
    while (Active(job) > 1) System.Threading.Thread.Sleep(100);
    Mark("empty");
    ExitProcess(code);
  }
}
`;

// Progress records would otherwise reach the CLI's stderr as CLIXML.
const SCRIPT = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
${WARDEN_SOURCE}
'@
[OverdriveTree]::Invoke($env:OVERDRIVE_TREE_MODE, $env:OVERDRIVE_TREE_JOB, $env:OVERDRIVE_TREE_ARGV)
`;
const ENCODED = Buffer.from(SCRIPT, 'utf16le').toString('base64');

function powershell() {
  return path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function invocation(mode, job, argv = []) {
  if (!MODES.has(mode)) throw new Error(`Unknown process-tree mode ${mode}`);
  return {
    command: powershell(),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', ENCODED],
    env: { OVERDRIVE_TREE_MODE: mode, OVERDRIVE_TREE_JOB: job, OVERDRIVE_TREE_ARGV: argv.map(arg => Buffer.from(String(arg), 'utf8').toString('base64')).join(',') },
  };
}

// Resolves 'absent' (no such job) or 'empty' (no process left in it), either of which proves
// nothing launched under it runs; 'present' when some process still does; otherwise 'unknown'.
function queryJob(job, timeoutMs = 30_000) {
  return new Promise(resolve => {
    const { command, args, env } = invocation('query', job);
    let out = '';
    let child;
    try { child = spawn(command, args, { env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { resolve('unknown'); return; }
    const timer = setTimeout(() => { child.kill(); resolve('unknown'); }, timeoutMs);
    child.stdout.on('data', chunk => { out += chunk; });
    child.once('error', () => { clearTimeout(timer); resolve('unknown'); });
    child.once('close', code => {
      clearTimeout(timer);
      const text = out.trim();
      const active = /^present (\d+)$/.exec(text);
      resolve(code !== 0 ? 'unknown' : text === 'absent' ? 'absent' : !active ? 'unknown' : active[1] === '0' ? 'empty' : 'present');
    });
  });
}

// Global names are visible to a controller restarted in another logon session of the same user;
// another user's job cannot be opened, which reads as 'unknown', never 'absent'.
//
// The warden's reports share stderr with the CLI and every tool that inherits it, so each carries
// a per-launch token the warden removes from the CLI's environment; a report without it is plain
// output. Reports only sequence the turn: whether the tree has ended is always read from the job.
export const windowsJobContainment = Object.freeze({
  jobName: id => `Global\\overdrive-worker-${id}`,
  // Only a native executable is started directly; anything else would run through cmd.exe.
  launch: ({ command, args }, job) => {
    if (!/\.exe$/i.test(command)) return null;
    const token = randomBytes(16).toString('hex');
    const spec = invocation('run', job, [command, ...args]);
    return { ...spec, env: { ...spec.env, OVERDRIVE_TREE_TOKEN: token }, job, token };
  },
  stop: job => invocation('stop', job),
  query: job => queryJob(job),
});

export function defaultContainment() {
  return process.platform === 'win32' ? windowsJobContainment : null;
}

// The state of a job recorded with a durable worker guard, as queryJob reports it.
export async function workerJobState(job) {
  if (process.platform !== 'win32' || typeof job !== 'string' || !/^Global\\overdrive-worker-[\w-]+$/.test(job)) return 'unknown';
  return await queryJob(job);
}
