import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir, platform, arch, release } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { digest, execute, message, shellCommand } from './process.ts';
import type { Execution } from './process.ts';

export type Target = {
  id: string; kind: 'regression' | 'related'; argv: string[]; hardware: 'cpu' | 'gpu';
  timeoutMs: number; requires: string[]; inputs: string[]; paths: string[];
  setup?: string[]; fail?: { exitCode: number; marker: string }; passMarker: string;
};

export type Config = {
  path: string; hash: string; targets: Target[]; editable: string[]; uncovered: string[]; hardware: 'cpu' | 'gpu';
};
export type ResultKind =
  'pass' | 'expected-failure' | 'test-failure' | 'no-tests' | 'missing-dependency' |
  'unsupported-hardware' | 'timeout' | 'execution-error' | 'unclassified-failure' | 'integrity-error';
export type TestRecord = {
  target: string; phase: 'before' | 'after' | 'related' | 'agent'; kind: ResultKind; version: string;
  prHead: string; patchHash?: string; testHash: string; argv: string[]; command: string;
  platform: string; runner: string; hardware: Config['hardware']; requires: string[]; startedAt: string;
  timeoutMs: number; setupArgv?: string[]; setupCommand?: string; setup?: Execution; execution?: Execution; reason?: string;
};

function isArgv(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(arg => typeof arg === 'string' && !arg.includes('\0')) && !!value[0];
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string' && !item.includes('\0'));
}
function plainPath(path: string) {
  return !!path && !isAbsolute(path) && !path.includes('\\') &&
    path.split('/').every(part => !!part && !['.', '..', '.git'].includes(part.toLowerCase()));
}
function marker(value: unknown) {
  return typeof value === 'string' && !!value.trim() && !/[\r\n]/.test(value);
}

export async function loadConfig(path: string): Promise<Config> {
  path = await realpath(path);
  const raw = await readFile(path);
  const data = JSON.parse(raw.toString()) as Partial<Config>;
  if (!['cpu', 'gpu'].includes(data.hardware ?? '') || !strings(data.editable) ||
      !data.editable.every(plainPath) || !strings(data.uncovered) || !Array.isArray(data.targets))
    throw new Error('Config requires hardware, editable paths, uncovered scope, and target definitions');
  const ids = new Set<string>();
  for (const target of data.targets) {
    if (!target || !/^[\w-]+$/.test(target.id) || ids.has(target.id) ||
        !['regression', 'related'].includes(target.kind) || !['cpu', 'gpu'].includes(target.hardware) ||
        !isArgv(target.argv) || (target.setup !== undefined && !isArgv(target.setup)) ||
        !Number.isSafeInteger(target.timeoutMs) || target.timeoutMs < 1 || target.timeoutMs > 900_000 ||
        !strings(target.requires) || !strings(target.inputs) || !strings(target.paths) ||
        !target.paths.every(plainPath) || !marker(target.passMarker) || (target.kind === 'regression' &&
          (!target.fail || !marker(target.fail.marker) || target.fail.marker === target.passMarker ||
            !Number.isSafeInteger(target.fail.exitCode) || target.fail.exitCode < 1 || target.fail.exitCode > 125)))
      throw new Error('Invalid or duplicate target: ' + JSON.stringify(target?.id));
    ids.add(target.id);
  }
  return {path, hash: digest(raw), editable: data.editable, hardware: data.hardware!, uncovered: data.uncovered, targets: data.targets};
}

export async function requiredGit(cwd: string, args: string[], options: {env?: NodeJS.ProcessEnv; timeoutMs?: number; maxBytes?: number} = {}) {
  const gitEnv = Object.fromEntries(Object.entries(options.env ?? process.env).filter(([key]) => !key.startsWith('GIT_')));
  gitEnv.GIT_TERMINAL_PROMPT = '0';
  if (options.env?.FORK_RECHECK_FIXTURE === '1') {
    gitEnv.GIT_COMMITTER_DATE = '2026-11-12T00:00:00Z';
  }
  const result = await execute(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
    '-c', 'core.autocrlf=false', ...args], cwd, {...options, env: gitEnv});
  if (result.exitCode !== 0 || result.truncated || result.timedOut)
    throw new Error('git ' + args[0] + ': ' + (result.error || result.output.trim() || 'failed'));
  return result.output;
}

export async function resolveHead(repo: string, head: string) {
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error('Invalid Git object ID');
  try {
    const actual = (await requiredGit(repo, ['rev-parse', '--verify', head + '^{commit}'])).trim();
    if (actual === head) return actual;
  } catch {
    throw new Error('PR head ' + head + ' is missing locally. Fetch the PR ref into the supplied checkout, then retry.');
  }
  throw new Error('Requested head is not an exact commit object');
}

export async function withWorktree<T>(repo: string, head: string, action: (cwd: string) => Promise<T>) {
  await resolveHead(repo, head);
  const parent = await mkdtemp(join(tmpdir(), 'fork-recheck-worktree-'));
  const cwd = join(parent, basename(parent));
  let added = false;
  try {
    await requiredGit(repo, ['worktree', 'add', '--detach', cwd, head], {timeoutMs: 240_000});
    added = true;
    return await action(cwd);
  } finally {
    if (added) {
      try { await requiredGit(repo, ['worktree', 'remove', '--force', cwd]); }
      catch (error) { throw new Error('Worktree cleanup failed at ' + cwd + ': ' + message(error)); }
    }
    await rm(parent, {recursive: true, force: true});
  }
}

export async function createFixtureRepo(dir: string, sourceDir?: string) {
  await mkdir(dir, {recursive: true});
  if (sourceDir) await cp(sourceDir, dir, {recursive: true});
  else await writeFile(join(dir, 'score.js'), 'export const score = (a, b) => a.at(-1) === b.at(-1);\n');
  await requiredGit(dir, ['init', '-q', '--initial-branch=main', '--object-format=sha1']);
  await requiredGit(dir, ['add', '--all']);
  await requiredGit(dir, ['-c', 'user.name=ForkRecheck Fixture', '-c', 'user.email=fixture@example.invalid', 'commit',
    '-q', '--no-gpg-sign', '--date=2026-11-12T00:00:00Z', '-m', 'Offline fixture'],
    {env: {...process.env, FORK_RECHECK_FIXTURE: '1', TZ: 'UTC'}});
  return (await requiredGit(dir, ['rev-parse', 'HEAD'])).trim();
}

function expand(argv: string[], config: Config) {
  return argv.map(arg => arg.replaceAll('{configDir}', dirname(config.path)).replaceAll('{node}', process.execPath));
}

export async function testHash(config: Config, target: Target) {
  const inputs = await Promise.all(target.inputs.map(async path =>
    [path, digest(await readFile(resolve(dirname(config.path), path)))]));
  return digest(JSON.stringify({target, inputs}));
}

export function classifyTest(result: Execution, target: Target, setup = false): ResultKind {
  if (result.timedOut) return 'timeout';
  if (result.errorCode === 'ENOENT') return 'missing-dependency';
  if (result.error || result.signal || result.truncated) return 'execution-error';
  const lines = result.output.split(/\r?\n/);
  if (/ModuleNotFoundError:|ImportError:|ERR_MODULE_NOT_FOUND|Cannot find module|command not found|No module named/i.test(result.output))
    return 'missing-dependency';
  if (/no tests ran|collected 0 items|no tests (found|collected)/i.test(result.output)) return 'no-tests';
  if (setup) return result.exitCode === 0 ? 'pass' : 'unclassified-failure';
  if (result.exitCode === 0) return lines.includes(target.passMarker) && !lines.includes(target.fail?.marker ?? '\0')
    ? 'pass' : 'unclassified-failure';
  if (result.exitCode === target.fail?.exitCode && lines.includes(target.fail.marker) && !lines.includes(target.passMarker))
    return 'expected-failure';
  return /(^|\n)(FAILED |AssertionError:|not ok )|\b[1-9]\d* failed\b/.test(result.output) ?
    'test-failure' : 'unclassified-failure';
}

export async function makePatch(cwd: string) {
  return requiredGit(cwd, ['diff', 'HEAD', '--no-ext-diff', '--no-textconv', '--binary', '--full-index',
    '--src-prefix=a/', '--dst-prefix=b/', '--'], {maxBytes: 2_000_000});
}

export async function runTarget(cwd: string, config: Config, target: Target, context: {
  version: string; prHead: string; phase: TestRecord['phase']; patchHash?: string;
}): Promise<TestRecord> {
  const argv = expand(target.argv, config);
  const setupArgv = target.setup ? expand(target.setup, config) : undefined;
  const record: TestRecord = {
    ...context, target: target.id, kind: 'integrity-error', testHash: '', argv, command: shellCommand(argv),
    hardware: config.hardware, platform: [platform(), arch(), release()].join('/'), requires: target.requires,
    runner: 'Node ' + process.version, timeoutMs: target.timeoutMs, setupArgv,
    setupCommand: setupArgv ? shellCommand(setupArgv) : undefined, startedAt: new Date().toISOString(),
  };
  try {
    record.testHash = await testHash(config, target);
    if (target.hardware === 'gpu' && config.hardware !== 'gpu')
      return {...record, kind: 'unsupported-hardware', reason: 'Target requires GPU; local configuration declares CPU.'};
    const initialPatch = await makePatch(cwd);
    if ((initialPatch ? digest(initialPatch) : undefined) !== context.patchHash)
      throw new Error('Worktree does not match the expected test subject');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/token|secret|password|credential|api.?key|^git_/i.test(key)));
    env.PYTHONDONTWRITEBYTECODE = '1';
    const options = {env, timeoutMs: target.timeoutMs};
    if (setupArgv) {
      record.setup = await execute(setupArgv, cwd, options);
      record.kind = classifyTest(record.setup, target, true);
      if (record.kind !== 'pass') return record;
    }
    record.execution = await execute(argv, cwd, options);
    record.kind = classifyTest(record.execution, target);
    if (record.testHash !== await testHash(config, target) || initialPatch !== await makePatch(cwd) ||
        (await requiredGit(cwd, ['rev-parse', 'HEAD'])).trim() !== context.version)
      throw new Error('Test changed its declared inputs, checkout commit, or tracked files');
    return record;
  } catch (error) {
    return {...record, kind: 'integrity-error', reason: message(error)};
  }
}

export async function repoFile(cwd: string, path: string) {
  if (!plainPath(path)) throw new Error('Invalid repo-relative path');
  const absolute = join(cwd, path);
  const stat = await lstat(absolute);
  if (!stat.isFile() || stat.size > 200_000 || relative(await realpath(cwd), await realpath(absolute)).split(sep).join('/') !== path)
    throw new Error('Path must name a regular non-symlink file inside the checkout (max 200 KB)');
  await requiredGit(cwd, ['--literal-pathspecs', 'ls-files', '--error-unmatch', '--', path]);
  return absolute;
}

export type Edit = { path: string; old: string; replacement: string };
export async function applyEdits(cwd: string, config: Config, edits: Edit[]) {
  if (!edits.length || edits.length > 12) throw new Error('Expected 1–12 edits.');
  const changed = new Map<string, {file: string; content: string}>();
  for (const edit of edits) {
    if (!config.editable.includes(edit.path) || !edit.old || edit.old === edit.replacement ||
        edit.old.includes('\0') || edit.replacement.includes('\0'))
      throw new Error('Invalid or out-of-scope edit: ' + edit.path);
    const file = await repoFile(cwd, edit.path);
    const content = changed.get(edit.path)?.content ?? new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(await readFile(file));
    const match = content.indexOf(edit.old);
    if (content.includes('\0') || match < 0 || content.indexOf(edit.old, match + 1) >= 0)
      throw new Error('Edit context must match exactly once: ' + edit.path);
    changed.set(edit.path, {file, content: content.slice(0, match) + edit.replacement + content.slice(match + edit.old.length)});
  }
  for (const {file, content} of changed.values()) await writeFile(file, content);
  await requiredGit(cwd, ['diff', '--check', 'HEAD']);
  return makePatch(cwd);
}

export async function applyPatch(cwd: string, config: Config, file: string) {
  const summary = await requiredGit(cwd, ['apply', '--numstat', '-z', '--', file], {maxBytes: 200_000});
  const paths = summary.split('\0').filter(Boolean).map(row => row.split('\t').slice(2).join('\t'));
  if (!paths.length || paths.some(path => !config.editable.includes(path))) throw new Error('Patch changes a path outside config.editable');
  for (const path of paths) await repoFile(cwd, path);
  await requiredGit(cwd, ['apply', '--check', '--', file]);
  await requiredGit(cwd, ['apply', '--', file]);
  await requiredGit(cwd, ['diff', '--check', 'HEAD']);
  for (const path of paths) await repoFile(cwd, path);
  return makePatch(cwd);
}
