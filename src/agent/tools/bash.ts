import { exec } from 'node:child_process';
import type { Tool } from '../tool-registry.js';

export const bashTool: Tool = {
  name: 'bash',
  description: 'Run a shell command and return stdout, stderr, and exit code. Use this for system commands, package management, git, etc.',
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
