#!/usr/bin/env node
import { readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { piAgent } from './agent.ts';
import { evaluate } from './evaluate.ts';
import { GitHub } from './github.ts';
import { loadConfig } from './local.ts';
import { message, shellCommand } from './process.ts';
import { cases, fixtureCase, replay, withReplay } from './replay.ts';
import type { PatchManifest } from './report.ts';
import { run, verify, verifyCommand } from './workflow.ts';

const help = `ForkRecheck

  fork-recheck check PR_URL --repo REPO [--out DIR]
  fork-recheck check PR_URL --repo REPO --fix --config FILE --model PROVIDER/MODEL [--out DIR]
  fork-recheck verify RUN_DIR [--repo REPO --config FILE] [--out DIR]
  fork-recheck replay CASE [--model PROVIDER/MODEL] [--out DIR]
  fork-recheck eval [--model PROVIDER/MODEL] [--out DIR]

Replay cases: ${cases.join(', ')}.
Options: GH_TOKEN or GITHUB_TOKEN for GitHub read access. Pi uses its own provider credentials.
Run with Node >=24.12. Exit 2 means a requested patch or verification is blocked or the snapshot is stale.
`;

async function main() {
  const {values, positionals} = parseArgs({
    allowPositionals: true,
    options: {repo: {type: 'string'}, config: {type: 'string'}, out: {type: 'string'},
      model: {type: 'string'}, fix: {type: 'boolean'}, help: {type: 'boolean', short: 'h'}},
  });
  const [command, input, ...extra] = positionals;
  if (!command || values.help || command === 'help') { console.log(help); return; }
  if (extra.length) throw new Error('Too many positional arguments');
  const allowed: Record<string, string[]> = {
    check: ['repo', 'config', 'out', 'fix', 'model'], verify: ['repo', 'config', 'out'],
    replay: ['model', 'out'], eval: ['model', 'out'],
  };
  if (!Object.hasOwn(allowed, command)) throw new Error('Unknown command. Use --help.');
  if (Object.keys(values).some(key => !allowed[command].includes(key))) throw new Error('Option is not valid for ' + command);
  const output = resolve(values.out ?? '.fork-recheck');
  const agent = values.model ? piAgent(values.model) : undefined;
  if (command === 'eval') {
    if (input) throw new Error('eval takes no positional argument');
    const result = await evaluate(output, agent, values.model);
    console.log(JSON.stringify({directory: result.dir, metrics: result.metrics}, null, 2));
    if (values.model && result.trials.some(trial => trial.error)) process.exitCode = 2;
    return;
  }
  if (!input) throw new Error('Missing argument. Use --help.');
  if (command === 'replay') {
    const id = fixtureCase(input);
    const {dir, report} = await replay(id, output, agent, values.model);
    console.log(report.state + ' | ' + report.decision + '\n' + join(dir, 'report.md') + '\n' + join(dir, 'report.json'));
    if (values.model && ['verl', 'fix'].includes(id) && report.state !== 'patch-verified') process.exitCode = 2;
    return;
  }
  if (command === 'check') {
    if (!values.repo) throw new Error('check requires --repo');
    if (values.fix && (!values.config || !agent)) throw new Error('--fix requires --config and --model');
    if (agent && !values.fix) throw new Error('--model requires --fix for check');
    const repo = await realpath(values.repo);
    const config = values.config ? await loadConfig(values.config) : undefined;
    const source = new GitHub(input);
    const rerun = shellCommand(['fork-recheck', 'check', source.pr.url, '--repo', repo, '--out', output,
      ...(config ? ['--config', config.path] : []), ...(values.fix ? ['--fix', '--model', values.model!] : [])]);
    const {dir, report} = await run({repo, config, source, output, agent, rerun,
      verifyCommand: dir => verifyCommand(dir, repo, config?.path)});
    console.log(report.state + ' | ' + report.decision + '\n' + join(dir, 'report.md') + '\n' + join(dir, 'report.json'));
    if (['stale', 'unverified'].includes(report.freshness) ||
        (values.fix && ['reproduce', 'inspect-failure'].includes(report.assessment.decision) && !report.patch)) process.exitCode = 2;
    return;
  }
  const original = await realpath(input);
  const manifest = JSON.parse(await readFile(join(original, 'patch.json'), 'utf8')) as PatchManifest;
  if (manifest.schema !== 1) throw new Error('Unsupported patch manifest schema');
  if (manifest.fixture && (values.repo || values.config)) throw new Error('Replay verification uses its bundled repo and config. Pass RUN_DIR only.');
  const rerun = shellCommand(['fork-recheck', 'verify', original, '--out', output,
    ...(values.repo ? ['--repo', resolve(values.repo)] : []), ...(values.config ? ['--config', resolve(values.config)] : [])]);
  const options = {manifest, patchFile: join(original, 'patch.diff'), output, rerun, verifyCommand: () => rerun};
  const result = manifest.fixture
    ? await withReplay(fixtureCase(manifest.fixture), data => verify({...options, ...data, fixture: manifest.fixture}))
    : await verify({...options, repo: await realpath(values.repo ?? fail('verify requires --repo for live runs')),
      config: await loadConfig(values.config ?? fail('verify requires --config for live runs')), source: new GitHub(manifest.url)});
  console.log(result.report.state + '\n' + join(result.dir, 'report.md') + '\n' + join(result.dir, 'report.json'));
  if (result.report.state !== 'independently-verified') process.exitCode = 2;
}

function fail(text: string): never { throw new Error(text); }

main().catch(error => {
  console.error('ForkRecheck: ' + message(error));
  process.exitCode = 1;
});
