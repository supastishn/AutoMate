import { spawn, type ChildProcess } from 'node:child_process';
import type { Tool } from '../tool-registry.js';

interface BackgroundProcess {
  id: string;
  command: string;
  proc: ChildProcess;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  startedAt: string;
  pid: number;
}

const processes: Map<string, BackgroundProcess> = new Map();
let nextId = 1;

const MAX_BUFFER = 100 * 1024; // 100KB cap per stream

function elapsed(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return `${mins}m${remSecs}s`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hrs}h${remMins}m${remSecs}s`;
}

export const processTools: Tool[] = [
  {
    name: 'process',
    description: [
      'Manage background processes.',
      'Actions: start, poll, write, kill, list.',
      'start — start a long-running command in the background.',
      'poll — get current output and status of a background process.',
      'write — send stdin input to a running process.',
      'kill — kill a background process.',
      'list — list all background processes with their status.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action: start|poll|write|kill|list',
        },
        command: { type: 'string', description: 'Shell command to run (for start)' },
        workdir: { type: 'string', description: 'Working directory (for start)' },
        id: { type: 'string', description: 'Background process ID e.g. bg_1 (for poll, write, kill)' },
        input: { type: 'string', description: 'Text to write to stdin (for write)' },
        signal: { type: 'string', description: 'Signal to send (for kill, default SIGTERM)' },
        clear: { type: 'boolean', description: 'Clear output buffer after reading (for poll, default false)' },
      },
      required: ['action'],
    },
    async execute(params, ctx) {
      const action = params.action as string;

      switch (action) {
        case 'start': {
          const command = params.command as string;
          if (!command) return { output: '', error: 'command is required for start action' };
          const workdir = (params.workdir as string) || ctx.workdir;
          const id = `bg_${nextId++}`;

          const proc = spawn('sh', ['-c', command], {
            cwd: workdir,
            env: process.env,
            stdio: ['pipe', 'pipe', 'pipe'],
          });

          const bg: BackgroundProcess = {
            id, command, proc,
            stdout: '', stderr: '',
            exitCode: null,
            startedAt: new Date().toISOString(),
            pid: proc.pid!,
          };

          proc.stdout!.on('data', (chunk: Buffer) => {
            bg.stdout += chunk.toString();
            if (bg.stdout.length > MAX_BUFFER) bg.stdout = bg.stdout.slice(-MAX_BUFFER);
          });
          proc.stderr!.on('data', (chunk: Buffer) => {
            bg.stderr += chunk.toString();
            if (bg.stderr.length > MAX_BUFFER) bg.stderr = bg.stderr.slice(-MAX_BUFFER);
          });
          proc.on('exit', (code) => { bg.exitCode = code; });

          processes.set(id, bg);
          return { output: `Started background process ${id} (PID: ${bg.pid})\nCommand: ${command}` };
        }

        case 'poll': {
          const id = params.id as string;
          const clear = (params.clear as boolean) ?? false;
          const bg = processes.get(id);
          if (!bg) return { output: '', error: `No background process found with id: ${id}` };

          const running = bg.exitCode === null;
          const status = running ? 'running' : `exited (code ${bg.exitCode})`;
          const runtime = elapsed(bg.startedAt);
          const stdoutTail = bg.stdout.length > 10000 ? bg.stdout.slice(-10000) : bg.stdout;
          const stderrTail = bg.stderr.length > 5000 ? bg.stderr.slice(-5000) : bg.stderr;

          let output = `Process ${id} — ${status} — runtime: ${runtime}\nPID: ${bg.pid}`;
          if (stdoutTail) output += `\n\n--- stdout ---\n${stdoutTail}`;
          if (stderrTail) output += `\n\n--- stderr ---\n${stderrTail}`;
          if (!stdoutTail && !stderrTail) output += '\n(no output yet)';

          if (clear) { bg.stdout = ''; bg.stderr = ''; }
          return { output };
        }

        case 'write': {
          const id = params.id as string;
          const input = params.input as string;
          const bg = processes.get(id);
          if (!bg) return { output: '', error: `No background process found with id: ${id}` };
          if (bg.exitCode !== null) return { output: '', error: `Process ${id} has already exited (code ${bg.exitCode})` };
          if (!bg.proc.stdin || bg.proc.stdin.destroyed) return { output: '', error: `stdin is not available for process ${id}` };

          return new Promise((resolve) => {
            bg.proc.stdin!.write(input, (err) => {
              if (err) resolve({ output: '', error: `Failed to write to process ${id}: ${err.message}` });
              else resolve({ output: `Sent ${input.length} bytes to process ${id}` });
            });
          });
        }

        case 'kill': {
          const id = params.id as string;
          const signal = (params.signal as string) || 'SIGTERM';
          const bg = processes.get(id);
          if (!bg) return { output: '', error: `No background process found with id: ${id}` };
          if (bg.exitCode !== null) return { output: `Process ${id} already exited (code ${bg.exitCode})` };

          try {
            bg.proc.kill(signal as NodeJS.Signals);
            return { output: `Sent ${signal} to process ${id} (PID: ${bg.pid})` };
          } catch (err) {
            return { output: '', error: `Failed to kill process ${id}: ${err}` };
          }
        }

        case 'list': {
          if (processes.size === 0) return { output: 'No background processes.' };
          const lines: string[] = [];
          for (const bg of processes.values()) {
            const running = bg.exitCode === null;
            const status = running ? 'running' : `exited(${bg.exitCode})`;
            const cmd = bg.command.length > 60 ? bg.command.slice(0, 57) + '...' : bg.command;
            const runtime = elapsed(bg.startedAt);
            lines.push(`${bg.id}  PID:${bg.pid}  ${status}  ${runtime}  ${cmd}`);
          }
          return { output: lines.join('\n') };
        }

        default:
          return { output: `Error: Unknown action "${action}". Valid: start, poll, write, kill, list` };
      }
    },
  },
];
