import { basename, join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import type { Agent, Proposal } from './agent.ts';
import { sameVersion, triage } from './evidence.ts';
import type { Source } from './evidence.ts';
import { applyEdits, applyPatch, resolveHead, runTarget, withWorktree } from './local.ts';
import type { Config, Target, TestRecord } from './local.ts';
import { digest, message, shellCommand } from './process.ts';
import { runLog } from './report.ts';
import type { PatchManifest, Report } from './report.ts';

type Options = {
  source: Source; repo?: string; head?: string; output: string; config?: Config; agent?: Agent;
  rerun: string; verifyCommand: (dir: string) => string; fixture?: string;
};
type Log = Awaited<ReturnType<typeof runLog>>;

async function initialize(options: Options, log: Log) {
  await log.event('collection-started');
  const snapshot = await options.source.snapshot().catch(async error => {
    await log.event('collection-error', message(error));
    await log.json('collection-error.json', {error: message(error), rerun: options.rerun});
    throw new Error(message(error) + ' (run records: ' + log.dir + ')');
  });
  await log.json('snapshot.json', snapshot);
  const assessment = triage(snapshot);
  await log.event('assessed', assessment.decision);
  const report: Report = {
    schema: 1, runId: basename(log.dir), generatedAt: new Date().toISOString(), snapshot, assessment,
    decision: assessment.decision, state: 'inspected', nextStep: assessment.reason, freshness: 'unverified',
    tests: [], uncovered: options.config ? [...options.config.uncovered] : ['Local tests require a user-supplied config and explicit fix or verify command.'],
    rerun: options.rerun, config: options.config?.path,
  };
  return report;
}

async function recheck(options: Options, report: Report, log: Log) {
  try {
    report.finalVersion = await options.source.version();
    const drift = !sameVersion(report.snapshot.version, report.finalVersion) ||
      (!!report.snapshot.endVersion && !sameVersion(report.snapshot.version, report.snapshot.endVersion));
    report.freshness = drift ? 'stale' : !report.snapshot.endVersion ? 'unverified' : options.fixture ? 'fixture' : 'current';
  } catch (error) {
    report.freshness = 'unverified';
    await log.event('version-recheck-error', message(error));
  }
  await log.event('version-rechecked', {freshness: report.freshness, version: report.finalVersion});
  if (report.freshness === 'stale' || report.freshness === 'unverified') {
    report.state = report.freshness === 'stale' ? 'stale' : 'version-unverified';
    report.decision = report.freshness === 'stale' ? 'stale' : 'refresh-evidence';
    report.nextStep = 'Results refer to the captured snapshot. Re-run the command to collect and verify the latest version.';
  }
}

function relevant(proposal: Proposal, target: Target, report: Report) {
  const {reviews, checks} = report.assessment;
  const usableReviews = reviews.filter(review => proposal.evidence.includes(review.id) &&
    ['current', 'older-anchor-present'].includes(review.applicability) &&
    (!review.path || target.paths.includes(review.path)));
  const usableFailures = checks.filter(check => proposal.evidence.includes(check.id) && !check.superseded &&
    ['head', 'merge'].includes(check.binding) && ['failure', 'error', 'startup_failure', 'timed_out'].includes(check.conclusion ?? '') &&
    check.logs?.some(log => log.state === 'available'));
  return usableReviews.length > 0 || usableFailures.length > 0;
}

function baselineBlocked(record: TestRecord, report: Report) {
  if (record.kind === 'expected-failure') return false;
  const environment = ['missing-dependency', 'unsupported-hardware', 'timeout', 'no-tests', 'execution-error'].includes(record.kind);
  report.state = environment ? 'blocked-environment' : 'unreproduced';
  if (environment) report.decision = 'restore-environment';
  report.nextStep = record.kind === 'pass'
    ? 'The selected regression passed before edits. Check whether the review still applies or choose another configured case.'
    : 'Baseline returned ' + record.kind + '. Resolve the reported cause and rerun before editing.';
  return true;
}

async function test(cwd: string, config: Config, target: Target, report: Report, log: Log, phase: TestRecord['phase'], patchHash?: string) {
  await log.event('test-started', {id: target.id, phase});
  const record = await runTarget(cwd, config, target, {
    version: report.checkoutHead!, prHead: report.snapshot.version.head, phase, patchHash,
  });
  report.tests.push(record);
  await log.event('test-finished', record);
  return record;
}

async function checkPatch(cwd: string, target: Target, config: Config, report: Report, log: Log, hash: string) {
  const result = await test(cwd, config, target, report, log, 'after', hash);
  const before = report.tests.find(record => record.phase === 'before');
  if (before?.testHash !== result.testHash || result.kind !== 'pass') {
    report.state = 'patch-rejected';
    report.nextStep = 'The unchanged regression failed after applying the candidate or its test inputs changed.';
    return false;
  }
  for (const related of config.targets.filter(target => target.kind === 'related')) {
    const record = await test(cwd, config, related, report, log, 'related', hash);
    if (record.kind === 'unsupported-hardware') report.uncovered.push(related.id + ' requires GPU.');
  }
  if (report.tests.some(result => result.phase === 'related' && !['pass', 'unsupported-hardware'].includes(result.kind))) {
    report.state = 'patch-rejected';
    report.nextStep = 'One or more configured related checks failed. Inspect their execution records.';
    return false;
  }
  return true;
}

export async function run(options: Options) {
  const log = await runLog(options.output);
  const report = await initialize(options, log);
  const {repo, config, agent} = options;
  let candidate: string | undefined;
  let target: Target | undefined;
  if (agent && ['reproduce', 'inspect-failure'].includes(report.decision)) {
    try {
      if (!repo || !config) throw new Error('Fix requires --repo and --config');
      const head = await resolveHead(repo, options.head ?? report.snapshot.version.head);
      report.checkoutHead = head;
      report.model = agent.label;
      const proposal = await withWorktree(repo, head, async cwd => {
        await log.event('agent-started', agent.label);
        return agent.propose({cwd, snapshot: report.snapshot, config}, log.agent);
      });
      report.proposal = proposal;
      await log.agent({type: 'proposal', proposal});
      target = config.targets.find(target => target.kind === 'regression' && target.id === proposal.target);
      if (!target || !proposal.edits.length || !['reproduce', 'inspect-failure'].includes(proposal.decision) ||
          !relevant(proposal, target, report)) {
        report.state = 'proposal-needs-evidence';
        report.nextStep = 'Provide a configured regression and cite an applicable review or a current failed check with logs.';
      } else {
        const baseline = await withWorktree(repo, head, cwd => test(cwd, config, target!, report, log, 'before'));
        if (!baselineBlocked(baseline, report)) {
          // Separate worktrees prevent the baseline command's local output from affecting verification.
          candidate = await withWorktree(repo, head, async cwd => {
            await log.event('candidate-apply-started', {head});
            const patch = await applyEdits(cwd, config, proposal.edits);
            if (!patch) throw new Error('Proposal produced an empty patch');
            await log.event('candidate-applied', {sha256: digest(patch), head});
            return await checkPatch(cwd, target!, config, report, log, digest(patch)) ? patch : undefined;
          });
        }
      }
    } catch (error) {
      report.state = 'local-work-blocked';
      report.nextStep = message(error);
      await log.event('local-work-error', message(error));
    }
  } else if (agent) {
    await log.event('fix-gated', report.decision);
  } else if (repo) {
    try { report.checkoutHead = await resolveHead(repo, options.head ?? report.snapshot.version.head); }
    catch (error) { report.uncovered.push(message(error)); }
  }
  await recheck(options, report, log);
  if (candidate && target && config && ['current', 'fixture'].includes(report.freshness)) {
    const manifest: PatchManifest = {
      schema: 1, url: report.snapshot.url, version: report.snapshot.version, checkoutHead: report.checkoutHead!,
      sha256: digest(candidate), configHash: config.hash, target: target.id, fixture: options.fixture,
      testHashes: Object.fromEntries(report.tests.filter(test => test.phase !== 'before').map(test => [test.target, test.testHash])),
    };
    await writeFile(join(log.dir, 'patch.diff'), candidate, {flag: 'wx', mode: 0o600});
    await log.json('patch.json', manifest);
    report.patch = manifest;
    report.state = 'patch-verified';
    report.nextStep = 'Review patch.diff and rerun independent verification. Local test coverage is recorded below.';
    report.verify = options.verifyCommand(log.dir);
    await log.event('patch-exported', manifest.sha256);
  }
  await log.event('finished', report.state);
  await log.finish(report);
  return {dir: log.dir, report};
}

export async function verify(options: Options & {repo: string; config: Config; patchFile: string; manifest: PatchManifest}) {
  const log = await runLog(options.output);
  const report = await initialize(options, log);
  const {repo, config, manifest, patchFile} = options;
  try {
    if (manifest.schema !== 1 || manifest.url !== report.snapshot.url || !sameVersion(manifest.version, report.snapshot.version) ||
        !report.snapshot.endVersion || !sameVersion(report.snapshot.version, report.snapshot.endVersion)) {
      report.state = 'stale';
      report.decision = 'stale';
      report.nextStep = 'Patch belongs to another PR version. Re-run the original check/fix command.';
    } else {
      const head = await resolveHead(repo, options.head ?? report.snapshot.version.head);
      report.checkoutHead = head;
      if (head !== manifest.checkoutHead || config.hash !== manifest.configHash ||
        manifest.sha256 !== digest(await readFile(patchFile))) throw new Error('Checkout, config, or patch hash mismatch');
      const target = config.targets.find(target => target.kind === 'regression' && target.id === manifest.target);
      if (!target) throw new Error('Regression target is missing from the config');
      const baseline = await withWorktree(repo, head, cwd => test(cwd, config, target, report, log, 'before'));
      if (baseline.testHash !== manifest.testHashes[target.id]) throw new Error('Regression inputs differ from the original run');
      if (!baselineBlocked(baseline, report)) {
        await withWorktree(repo, head, async cwd => {
          const applied = await applyPatch(cwd, config, patchFile);
          if (digest(applied) !== manifest.sha256) throw new Error('Applied patch does not match its manifest');
          if (await checkPatch(cwd, target, config, report, log, manifest.sha256)) {
            if (report.tests.some(test => test.testHash !== manifest.testHashes[test.target]))
              throw new Error('Related test inputs differ from the original run');
            report.state = 'independently-verified';
            report.nextStep = 'Fresh worktrees reproduced the original failure and passed the patched checks.';
          }
        });
      }
    }
  } catch (error) {
    report.state = 'verification-rejected';
    report.nextStep = message(error);
    await log.event('verification-error', message(error));
  }
  await recheck(options, report, log);
  await log.event('finished', report.state);
  await log.finish(report);
  return {dir: log.dir, report};
}

export function verifyCommand(dir: string, repo?: string, config?: string) {
  return shellCommand(['fork-recheck', 'verify', dir, ...(repo ? ['--repo', repo] : []), ...(config ? ['--config', config] : [])]);
}
