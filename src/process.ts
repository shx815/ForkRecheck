import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

export type Execution = {
  exitCode: number | null; signal: string | null; output: string; truncated: boolean;
  timedOut: boolean; error?: string; errorCode?: string; ms: number;
};

export function execute(argv: string[], cwd: string, options: {
  timeoutMs?: number; env?: NodeJS.ProcessEnv; maxBytes?: number;
} = {}): Promise<Execution> {
  const started = Date.now();
  return new Promise(resolve => {
    const processGroup = process.platform !== 'win32';
    const child = spawn(argv[0], argv.slice(1), {
      cwd, env: options.env, detached: processGroup, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const maxBytes = options.maxBytes ?? 128_000;
    const output: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let timedOut = false;
    let error: NodeJS.ErrnoException | undefined;
    function receive(chunk: Buffer) {
      const accepted = Math.max(0, Math.min(chunk.length, maxBytes - size));
      if (accepted < chunk.length) truncated = true;
      if (accepted) output.push(chunk.subarray(0, accepted));
      size += accepted;
    }
    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        if (processGroup && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== 'ESRCH') error = failure as NodeJS.ErrnoException;
      }
    }, options.timeoutMs ?? 30_000);
    child.stdout.on('data', receive);
    child.stderr.on('data', receive);
    child.on('error', failure => { error = failure; });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timeout);
      resolve({ exitCode, signal, output: Buffer.concat(output).toString(), truncated,
        timedOut, error: error?.message, errorCode: error?.code, ms: Date.now() - started });
    });
  });
}

export function digest(content: string | Buffer) {
  return createHash('sha256').update(content).digest('hex');
}

export function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function shellCommand(argv: string[]) {
  return argv.map(arg => /^[\w@%+=:,./-]+$/.test(arg) ? arg : "'" + arg.replaceAll("'", "'\\''") + "'").join(' ');
}
