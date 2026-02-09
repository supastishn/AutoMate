import { exec } from 'node:child_process';
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

export const bashTool: Tool = {
  name: 'bash',
  description: 'Run a shell command and return stdout, stderr, and exit code. Use this for system commands, package management, git, etc. Some dangerous commands (sudo, curl, rm -rf /, etc.) are blocked unless the session has elevated permissions (/elevated on).',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute' },
      timeout: { type: 'number', description: 'Timeout in milliseconds (default 120000)' },
      workdir: { type: 'string', description: 'Working directory for the command' },
    },
    required: ['command'],
  },
  async execute(params, ctx) {
    const command = params.command as string;
    const timeout = (params.timeout as number) || 120000;
    const workdir = (params.workdir as string) || ctx.workdir;

    // Safety check
    const blocked = checkCommand(command, !!ctx.elevated);
    if (blocked) {
      return {
        output: `Command blocked: ${blocked}\nUse /elevated on to enable elevated permissions for this session.`,
        error: 'BLOCKED',
      };
    }

    return new Promise((resolve) => {
      const proc = exec(command, {
        cwd: workdir,
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env },
      }, (error, stdout, stderr) => {
        const exitCode = error?.code ?? (proc.exitCode ?? 0);
        let output = '';
        if (stdout) output += stdout;
        if (stderr) output += (output ? '\n--- stderr ---\n' : '') + stderr;
        if (error && !stdout && !stderr) {
          output = error.message;
        }

        // Truncate if too large
        if (output.length > 50000) {
          output = output.slice(0, 50000) + '\n... (truncated)';
        }

        resolve({
          output: output || '(no output)',
          error: exitCode !== 0 ? `Exit code: ${exitCode}` : undefined,
        });
      });
    });
  },
};
