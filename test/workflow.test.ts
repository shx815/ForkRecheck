import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { classifyTest, requiredGit } from '../src/local.ts';
import type { Target } from '../src/local.ts';
import { execute } from '../src/process.ts';
import type { Execution } from '../src/process.ts';
import { mockAgent, replay, withReplay } from '../src/replay.ts';
import { run, verify } from '../src/workflow.ts';

async function sandbox<T>(action: (dir: string) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), 'forkrecheck-test-'));
  try { return await action(dir); }
  finally { await rm(dir, {recursive: true, force: true}); }
}

const target: Target = {id: 'behavior', kind: 'regression', argv: [], hardware: 'cpu', timeoutMs: 500, requires: [],
  inputs: [], paths: [], fail: {exitCode: 42, marker: 'BUG:42'}, passMarker: 'CASE PASSED'};
const outcome = (output: string, exitCode = 42): Execution =>
  ({output, exitCode, truncated: false, timedOut: false, signal: null, ms: 5});

test('reproduction requires the precise marker and exit code, with infrastructure failures taking precedence', () => {
  assert.equal(classifyTest(outcome('BUG:42'), target), 'expected-failure');
  assert.equal(classifyTest(outcome('prefix BUG:42'), target), 'unclassified-failure');
  assert.equal(classifyTest(outcome('BUG:42\nModuleNotFoundError: gpu'), target), 'missing-dependency');
  assert.equal(classifyTest(outcome('BUG:42\ncollected 0 items'), target), 'no-tests');
  assert.equal(classifyTest({...outcome('BUG:42'), timedOut: true}, target), 'timeout');
  assert.equal(classifyTest(outcome('AssertionError: another test failed', 1), target), 'test-failure');
  assert.equal(classifyTest(outcome('CASE PASSED', 0), target), 'pass');
  assert.equal(classifyTest(outcome('', 0), target), 'unclassified-failure');
  assert.equal(classifyTest(outcome('CASE PASSED\nBUG:42', 0), target), 'unclassified-failure');
});

test('runner returns timeout with separate process outcome', async () => sandbox(async dir => {
  const result = await execute([process.execPath, '-e', 'setInterval(() => {}, 5000)'], dir, {timeoutMs: 80});
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
}));

test('historical replay is reproducible and rechecked on fresh worktrees', async () => sandbox(async output => {
  const {report, dir} = await replay('verl', output);
  assert.equal(report.state, 'patch-verified');
  assert.notEqual(report.checkoutHead, report.snapshot.version.head);
  assert.deepEqual(report.tests.map(record => record.kind), ['expected-failure', 'pass', 'pass']);
  assert.equal(report.tests[0].testHash, report.tests[1].testHash);
  assert.match(report.tests[0].execution?.output ?? '', /combined-braced, combined-greek/);
  assert.match(report.tests[2].execution?.output ?? '', /16 historical case functions passed/);
  assert.ok(report.snapshot.reviews.every(review => review.at! <= report.snapshot.asOf!));
  const manifest = report.patch!;
  const check = await withReplay('verl', fixture => verify({
    ...fixture, output, manifest, fixture: 'verl', patchFile: join(dir, 'patch.diff'), rerun: '', verifyCommand: () => '',
  }));
  assert.equal(check.report.state, 'independently-verified');
  assert.equal(check.report.tests[1].patchHash, manifest.sha256);
  const tampered = join(dir, 'tampered.diff');
  await writeFile(tampered, (await readFile(join(dir, 'patch.diff'), 'utf8')) + '\n');
  const rejected = await withReplay('verl', fixture => verify({
    ...fixture, output, manifest, fixture: 'verl', patchFile: tampered, rerun: '', verifyCommand: () => '',
  }));
  assert.equal(rejected.report.state, 'verification-rejected');
  assert.equal(rejected.report.tests.length, 0);
}));

test('authorization and old-only failures do not invoke an agent or run tests', async () => sandbox(async output => {
  let calls = 0;
  const agent = {...mockAgent, async propose() { calls++; throw new Error('must not run'); }};
  const gate = await replay('authorization', output, agent);
  const history = await replay('old-failure', output, agent);
  assert.equal(gate.report.decision, 'request-authorization');
  assert.equal(history.report.decision, 'refresh-evidence');
  assert.equal(history.report.assessment.checks[0].binding, 'historical');
  assert.deepEqual([gate.report.tests.length, history.report.tests.length, calls], [0, 0, 0]);
}));

test('missing dependencies are recorded without changing local code', async () => sandbox(async output => {
  const {report, dir} = await replay('missing-dependency', output);
  assert.equal(report.state, 'blocked-environment');
  assert.equal(report.decision, 'restore-environment');
  assert.deepEqual(report.tests.map(record => record.kind), ['missing-dependency']);
  assert.ok(!(await readdir(dir)).includes('patch.diff'));
  assert.doesNotMatch(await readFile(join(dir, 'events.jsonl'), 'utf8'), /candidate-appl/);
}));

test('base drift after successful tests withholds a candidate and keeps verification records', async () => sandbox(async output => {
  const {report, dir} = await replay('updated', output);
  assert.equal(report.state, 'stale');
  assert.notEqual(report.snapshot.version.base, report.finalVersion?.base);
  assert.deepEqual(report.tests.map(record => record.kind), ['expected-failure', 'pass', 'pass']);
  assert.ok(!(await readdir(dir)).includes('patch.diff'));
  assert.match(await readFile(join(dir, 'events.jsonl'), 'utf8'), /candidate-applied/);
}));

test('worktrees leave dirty working files and HEAD alone', async () => sandbox(async output => {
  await withReplay('fix', async fixture => {
    const file = join(fixture.repo, 'score.js');
    await writeFile(file, 'user changes\n');
    const result = await run({...fixture, output, fixture: 'fix', agent: mockAgent, rerun: '', verifyCommand: () => ''});
    assert.equal(result.report.state, 'patch-verified');
    assert.equal(await readFile(file, 'utf8'), 'user changes\n');
    assert.equal((await requiredGit(fixture.repo, ['rev-parse', 'HEAD'])).trim(), fixture.head);
    assert.equal((await requiredGit(fixture.repo, ['worktree', 'list', '--porcelain'])).match(/^worktree /gm)?.length, 1);
  });
}));
