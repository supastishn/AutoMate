import { exec, spawn, ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { Tool } from '../tool-registry.js';

// Dangerous command patterns blocked when session is NOT elevated
const BLOCKED_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\bsudo\b/, reason: 'sudo requires elevated permissions' },
  { pattern: /\bsu\s+-?\s/, reason: 'su requires elevated permissions' },
  { pattern: /\bdoas\b/, reason: 'doas requires elevated permissions' },
  { pattern: /\bcurl\b.*\|\s*(ba)?sh/, reason: 'piping curl to shell is blocked' },
  { pattern: /\bwget\b.*\|\s*(ba)?sh/, reason: 'piping wget to shell is blocked' },
  { pattern: /\bcurl\b/, reason: 'curl requires elevated permissions' },
  { pattern: /\bwget\b/, reason: 'wget requires elevated permissions' },
  { pattern: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/\s*$/, reason: 'rm on root is blocked' },
  { pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|f[a-zA-Z]*r)\s+\//, reason: 'recursive rm on root paths is blocked' },
  { pattern: /\bdd\s+.*of=\/dev\//, reason: 'dd to device files is blocked' },
  { pattern: /\bmkfs\./, reason: 'mkfs requires elevated permissions' },
  { pattern: /\bfdisk\b/, reason: 'fdisk requires elevated permissions' },
  { pattern: /\bchmod\s+.*\/etc/, reason: 'chmod on /etc requires elevated permissions' },
  { pattern: /\bchown\b/, reason: 'chown requires elevated permissions' },
  { pattern: /\buseradd\b/, reason: 'useradd requires elevated permissions' },
  { pattern: /\buserdel\b/, reason: 'userdel requires elevated permissions' },
  { pattern: /\bpasswd\b/, reason: 'passwd requires elevated permissions' },
  { pattern: /\bshutdown\b/, reason: 'shutdown requires elevated permissions' },
  { pattern: /\breboot\b/, reason: 'reboot requires elevated permissions' },
  { pattern: /\bsystemctl\s+(start|stop|restart|enable|disable)\b/, reason: 'systemctl service management requires elevated permissions' },
  { pattern: /\biptables\b/, reason: 'iptables requires elevated permissions' },
  { pattern: />\s*\/etc\//, reason: 'writing to /etc is blocked' },
  { pattern: />\s*\/usr\//, reason: 'writing to /usr is blocked' },
  { pattern: /\beval\b.*\$\(curl/, reason: 'eval of remote content is blocked' },
  { pattern: /\bnc\s+(-[a-zA-Z]*)?\s*-l/, reason: 'nc listen mode requires elevated permissions' },
  { pattern: /\/dev\/tcp\//, reason: 'raw TCP access is blocked' },
  { pattern: /\bpkill\s+-9/, reason: 'pkill -9 requires elevated permissions' },
  { pattern: /\bkillall\b/, reason: 'killall requires elevated permissions' },
];

function checkCommand(command: string, elevated: boolean): string | null {
  if (elevated) return null; // elevated sessions skip all checks

  const normalized = command.trim();
  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(normalized)) {
      return reason;
    }
  }
  return null;
}

// ── Background Shell Support ─────────────────────────────────────────────

interface BackgroundShell {
  id: string;
  parentSessionId: string;
  command: string;
  status: 'running' | 'completed' | 'error' | 'killed';
  startTime: number;
  endTime?: number;
  output: string;
  exitCode?: number;
  error?: string;
  process?: ChildProcess;
}

const backgroundShells: Map<string, BackgroundShell> = new Map();

/** Callback to notify the parent session when a background shell finishes */
let notifyParentFn: ((parentSessionId: string, message: string) => void) | null = null;

/** Set the notifier function (called from agent setup) */
export function setBackgroundShellNotifier(fn: (parentSessionId: string, message: string) => void): void {
  notifyParentFn = fn;
}

function generateId(): string {
  return randomBytes(4).toString('hex');
}

/** Get all background shells (for API/tools) */
export function getBackgroundShells(): BackgroundShell[] {
  return [...backgroundShells.values()].map(s => ({
    ...s,
    process: undefined, // Don't expose process object
  }));
}

/** Get a specific background shell by ID */
export function getBackgroundShell(id: string): BackgroundShell | null {
  const shell = backgroundShells.get(id);
  if (!shell) return null;
  return { ...shell, process: undefined };
}

/** Kill a running background shell */
export function killBackgroundShell(id: string): BackgroundShell | null {
  const shell = backgroundShells.get(id);
  if (!shell) return null;

  if (shell.status === 'running' && shell.process) {
    shell.process.kill('SIGTERM');
    setTimeout(() => {
      try { shell.process?.kill('SIGKILL'); } catch {}
    }, 500);
    shell.status = 'killed';
    shell.endTime = Date.now();
    shell.error = 'Killed by user';
    // Don't set output here - the close handler will capture stdout/stderr and prepend '[KILLED]'
  }

  return { ...shell, process: undefined };
}

/** Clear completed background shells */
export function clearCompletedShells(): number {
  let cleared = 0;
  for (const [id, shell] of backgroundShells) {
    if (shell.status !== 'running') {
      backgroundShells.delete(id);
      cleared++;
    }
  }
  return cleared;
}

/** Cleanup old shells (keep max 50 completed) */
function cleanupOldShells(): void {
  const entries = [...backgroundShells.entries()];
  const completed = entries.filter(([, s]) => s.status !== 'running');
  if (completed.length > 50) {
    completed
      .sort((a, b) => (a[1].startTime - b[1].startTime))
      .slice(0, completed.length - 50)
      .forEach(([id]) => backgroundShells.delete(id));
  }
}

export const bashTool: Tool = {
  name: 'bash',
  description: 'Execute shell commands. Returns stdout, stderr, exit code. Use background=true for long-running processes. Some commands blocked without /elevated on.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute' },
      timeout: { type: 'number', description: 'Timeout in milliseconds (default 120000)' },
      workdir: { type: 'string', description: 'Working directory for the command' },
      background: { type: 'boolean', description: 'Run in background and report back when done (default false)' },
    },
    required: ['command'],
  },
  async execute(params, ctx) {
    const command = params.command as string;
    const timeout = (params.timeout as number) || 120000;
    const workdir = (params.workdir as string) || ctx.workdir;
    const background = params.background as boolean;

    // Safety check
    const blocked = checkCommand(command, !!ctx.elevated);
    if (blocked) {
      return {
        output: `Command blocked: ${blocked}\nUse /elevated on to enable elevated permissions for this session.`,
        error: 'BLOCKED',
      };
    }

    // Background mode
    if (background) {
      const id = generateId();
      const shell: BackgroundShell = {
        id,
        parentSessionId: ctx.sessionId || 'unknown',
        command,
        status: 'running',
        startTime: Date.now(),
        output: '',
      };

      const proc = spawn('sh', ['-c', command], {
        cwd: workdir,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      shell.process = proc;
      backgroundShells.set(id, shell);
      cleanupOldShells();

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      proc.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      proc.on('close', (code) => {
        // Don't overwrite status if already set (killed/timeout)
        if (shell.status !== 'running') {
          // Just update output and exit code
          let output = stdout;
          if (stderr) output += (output ? '\n--- stderr ---\n' : '') + stderr;
          if (output.length > 50000) {
            output = output.slice(0, 50000) + '\n... (truncated)';
          }
          if (output && !shell.output.includes(output)) {
            // Prepend captured output if not already there
            shell.output = output + '\n' + shell.output;
          }
          shell.exitCode = code ?? undefined;
          shell.process = undefined;
          return;
        }

        shell.status = code === 0 ? 'completed' : 'error';
        shell.exitCode = code ?? undefined;
        shell.endTime = Date.now();

        let output = stdout;
        if (stderr) output += (output ? '\n--- stderr ---\n' : '') + stderr;
        if (output.length > 50000) {
          output = output.slice(0, 50000) + '\n... (truncated)';
        }
        shell.output = output || '(no output)';
        shell.process = undefined;

        // Notify parent session
        if (notifyParentFn && shell.parentSessionId) {
          const duration = ((shell.endTime - shell.startTime) / 1000).toFixed(1);
          const preview = shell.output.slice(0, 1000);
          const status = shell.status === 'completed' ? '✓' : '✗';
          notifyParentFn(
            shell.parentSessionId,
            `[Background shell ${status} — ${id} finished in ${duration}s, exit code ${code}]\n$ ${command.slice(0, 100)}${command.length > 100 ? '...' : ''}\n\n${preview}${shell.output.length > 1000 ? '\n\n... (use shell_poll to see full output)' : ''}`
          );
        }
      });

      proc.on('error', (err) => {
        shell.status = 'error';
        shell.error = err.message;
        shell.endTime = Date.now();
        shell.process = undefined;

        // Capture any output that was collected before the error
        let capturedOutput = stdout;
        if (stderr) capturedOutput += (capturedOutput ? '\n--- stderr ---\n' : '') + stderr;
        if (capturedOutput.length > 50000) {
          capturedOutput = capturedOutput.slice(0, 50000) + '\n... (truncated)';
        }
        shell.output = capturedOutput ? `[ERROR: ${err.message}]\n${capturedOutput}` : `(error: ${err.message})`;

        if (notifyParentFn && shell.parentSessionId) {
          const preview = shell.output.slice(0, 1000);
          notifyParentFn(
            shell.parentSessionId,
            `[Background shell error — ${id}]: ${err.message}\n$ ${command.slice(0, 100)}${command.length > 100 ? '...' : ''}\n\n${preview}${shell.output.length > 1000 ? '\n\n... (use shell_poll to see full output)' : ''}`
          );
        }
      });

      // Set up timeout
      if (timeout > 0) {
        setTimeout(() => {
          if (shell.status === 'running') {
            proc.kill('SIGTERM');
            setTimeout(() => {
              try { proc.kill('SIGKILL'); } catch {}
            }, 500);
            shell.status = 'error';
            shell.error = 'Timeout';
            shell.endTime = Date.now();

            let capturedOutput = stdout;
            if (stderr) capturedOutput += (capturedOutput ? '\n--- stderr ---\n' : '') + stderr;
            if (capturedOutput.length > 50000) {
              capturedOutput = capturedOutput.slice(0, 50000) + '\n... (truncated)';
            }
            shell.output = capturedOutput ? `[TIMEOUT - killed after ${timeout}ms]\n${capturedOutput}` : `(timeout after ${timeout}ms, no output captured)`;

            if (notifyParentFn && shell.parentSessionId) {
              const preview = shell.output.slice(0, 1000);
              notifyParentFn(
                shell.parentSessionId,
                `[Background shell timeout — ${id} killed after ${timeout}ms]\n$ ${command.slice(0, 100)}${command.length > 100 ? '...' : ''}\n\n${preview}${shell.output.length > 1000 ? '\n\n... (use shell_poll to see full output)' : ''}`
              );
            }
          }
        }, timeout);
      }

      return {
        output: `Background shell started: ${id}\nCommand: ${command.slice(0, 200)}${command.length > 200 ? '...' : ''}\nYou will be notified when it completes. Use shell_poll to check status.`,
      };
    }

    // Foreground (blocking) mode
    return new Promise((resolve) => {
      let capturedStdout = '';
      let capturedStderr = '';
      let resolved = false;

      const proc = spawn('sh', ['-c', command], {
        cwd: workdir,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      proc.stdout?.on('data', (chunk) => {
        capturedStdout += chunk.toString();
      });

      proc.stderr?.on('data', (chunk) => {
        capturedStderr += chunk.toString();
      });

      const buildOutput = (prefix: string = ''): string => {
        let output = '';
        if (prefix) output += prefix + '\n';
        if (capturedStdout) output += capturedStdout;
        if (capturedStderr) output += (output ? '\n--- stderr ---\n' : '') + capturedStderr;
        if (output.length > 50000) {
          output = output.slice(0, 50000) + '\n... (truncated)';
        }
        return output || '(no output)';
      };

      const finalize = (prefix: string, errorStr: string) => {
        if (resolved) return;
        resolved = true;
        resolve({
          output: buildOutput(prefix),
          error: errorStr,
        });
      };

      // Timeout handler
      const timeoutId = setTimeout(() => {
        proc.kill('SIGTERM');
        setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch {}
        }, 500);
        finalize('[TIMEOUT - killed after ' + (timeout / 1000) + 's]', 'TIMEOUT');
      }, timeout);

      proc.on('close', (code) => {
        clearTimeout(timeoutId);
        if (resolved) return;
        resolved = true;

        const exitCode = code ?? 0;
        let output = '';
        if (capturedStdout) output += capturedStdout;
        if (capturedStderr) output += (output ? '\n--- stderr ---\n' : '') + capturedStderr;
        if (output.length > 50000) {
          output = output.slice(0, 50000) + '\n... (truncated)';
        }

        resolve({
          output: output || '(no output)',
          error: exitCode !== 0 ? `Exit code: ${exitCode}` : undefined,
        });
      });

      proc.on('error', (err) => {
        clearTimeout(timeoutId);
        finalize('[ERROR] ' + err.message, err.message);
      });

      // Listen for abort signal to kill the process
      if (ctx.signal) {
        const abortHandler = () => {
          clearTimeout(timeoutId);
          proc.kill('SIGTERM');
          setTimeout(() => {
            try { proc.kill('SIGKILL'); } catch {}
          }, 500);
          finalize('[INTERRUPTED]', 'INTERRUPTED');
        };
        if (ctx.signal.aborted) {
          abortHandler();
        } else {
          ctx.signal.addEventListener('abort', abortHandler, { once: true });
        }
      }
    });
  },
};

export const shellPollTool: Tool = {
  name: 'shell_poll',
  description: 'Check status and output of a background shell command by its ID.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The shell ID returned by bash with background=true' },
    },
    required: ['id'],
  },
  async execute(params) {
    const id = params.id as string;
    const shell = getBackgroundShell(id);

    if (!shell) {
      return {
        output: `No background shell found with ID: ${id}`,
        error: 'NOT_FOUND',
      };
    }

    const duration = shell.endTime
      ? ((shell.endTime - shell.startTime) / 1000).toFixed(1)
      : ((Date.now() - shell.startTime) / 1000).toFixed(1);

    return {
      output: JSON.stringify({
        id: shell.id,
        command: shell.command.slice(0, 200),
        status: shell.status,
        exitCode: shell.exitCode,
        duration: `${duration}s`,
        output: shell.output,
        error: shell.error,
      }, null, 2),
    };
  },
};

export const shellListTool: Tool = {
  name: 'shell_list',
  description: 'List all background shell commands with their status, duration, and ID.',
  parameters: {
    type: 'object',
    properties: {},
  },
  async execute() {
    const shells = getBackgroundShells();

    if (shells.length === 0) {
      return { output: 'No background shells.' };
    }

    const lines = shells.map(s => {
      const duration = s.endTime
        ? ((s.endTime - s.startTime) / 1000).toFixed(1)
        : ((Date.now() - s.startTime) / 1000).toFixed(1);
      const cmd = s.command.slice(0, 50) + (s.command.length > 50 ? '...' : '');
      return `${s.id} [${s.status}] ${duration}s — ${cmd}`;
    });

    return { output: lines.join('\n') };
  },
};

export const shellKillTool: Tool = {
  name: 'shell_kill',
  description: 'Kill a running background shell command by its ID. Sends SIGTERM then SIGKILL.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The shell ID to kill' },
    },
    required: ['id'],
  },
  async execute(params) {
    const id = params.id as string;
    const shell = killBackgroundShell(id);

    if (!shell) {
      return {
        output: `No background shell found with ID: ${id}`,
        error: 'NOT_FOUND',
      };
    }

    if (shell.status === 'killed') {
      return { output: `Shell ${id} killed.` };
    }

    return {
      output: `Shell ${id} was not running (status: ${shell.status}).`,
    };
  },
};

export const bashTools: Tool[] = [bashTool, shellPollTool, shellListTool, shellKillTool];
