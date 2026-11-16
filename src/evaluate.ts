import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Agent } from './agent.ts';
import { piBudget } from './agent.ts';
import type { Decision } from './evidence.ts';
import { applyEdits, testHash, withWorktree } from './local.ts';
import { digest, message } from './process.ts';
import { cases, mockAgent, replay, withReplay } from './replay.ts';
import type { Case } from './replay.ts';
import { runLog } from './report.ts';
import type { PatchManifest } from './report.ts';
import { verify } from './workflow.ts';

const gold: Record<Case, {decision: Decision; patchable: boolean}> = {
  verl: {decision: 'reproduce', patchable: true},
  fix: {decision: 'reproduce', patchable: true},
  authorization: {decision: 'request-authorization', patchable: false},
  'old-failure': {decision: 'refresh-evidence', patchable: false},
  'missing-dependency': {decision: 'restore-environment', patchable: false},
  updated: {decision: 'stale', patchable: false},
};

type Trial = {
  id: Case; arm: 'direct' | 'harness'; decision?: Decision; status: string; editTriggered: boolean;
  submittedPatch: boolean; independentPass?: boolean; error?: string; reportDir: string; verificationDir?: string;
};

async function independent(id: Case, dir: string, output: string, manifest: PatchManifest) {
  return withReplay(id, data => verify({
    ...data, output, fixture: id, manifest, patchFile: join(dir, 'patch.diff'),
    rerun: 'fork-recheck verify ' + dir, verifyCommand: () => '',
  }));
}

async function direct(id: Case, output: string, agent: Agent): Promise<Trial> {
  return withReplay(id, async ({repo, head, source, config}) => {
    const log = await runLog(output);
    const trial: Trial = {id, arm: 'direct', status: 'started', editTriggered: false, submittedPatch: false, reportDir: log.dir};
    try {
      const snapshot = await source.snapshot();
      await log.json('snapshot.json', snapshot);
      await log.event('direct-start', agent.label);
      const proposal = await withWorktree(repo, head, cwd => agent.propose({cwd, snapshot, config}, log.agent));
      await log.agent({type: 'proposal', proposal});
      trial.decision = proposal.decision;
      trial.status = 'answered';
      if (proposal.edits.length) {
        trial.editTriggered = true;
        const patch = await withWorktree(repo, head, cwd => applyEdits(cwd, config, proposal.edits));
        const target = config.targets.find(target => target.id === proposal.target && target.kind === 'regression');
        if (!patch || !target) throw new Error('Candidate has no patch or configured regression');
        const testHashes = Object.fromEntries(await Promise.all(
          [target, ...config.targets.filter(target => target.kind === 'related')].map(async target => [target.id, await testHash(config, target)]),
        ));
        const manifest: PatchManifest = {schema: 1, fixture: id, checkoutHead: head, target: target.id,
          url: snapshot.url, version: snapshot.version, configHash: config.hash, sha256: digest(patch), testHashes};
        await writeFile(join(log.dir, 'patch.diff'), patch, {mode: 0o600});
        await log.json('patch.json', manifest);
        trial.submittedPatch = true;
        trial.status = 'submitted';
        const result = await independent(id, log.dir, output, manifest);
        trial.independentPass = result.report.state === 'independently-verified';
        trial.verificationDir = result.dir;
      }
    } catch (error) { trial.error = message(error); trial.status = 'blocked'; }
    await log.json('trial.json', trial);
    return trial;
  });
}

export async function evaluate(output: string, agent = mockAgent, model?: string) {
  const log = await runLog(output);
  const root = join(log.dir, 'trials');
  const trials: Trial[] = [];
  for (const id of cases) {
    trials.push(await direct(id, root, agent));
    const result = await replay(id, root, agent, model);
    const stages = await readFile(join(result.dir, 'events.jsonl'), 'utf8');
    const trial: Trial = {
      id, arm: 'harness', status: result.report.state, decision: result.report.decision,
      editTriggered: stages.split('\n').filter(Boolean).some(line => JSON.parse(line).stage === 'candidate-apply-started'),
      submittedPatch: !!result.report.patch, reportDir: result.dir,
    };
    if (result.report.patch) {
      const verified = await independent(id, result.dir, root, result.report.patch);
      trial.independentPass = verified.report.state === 'independently-verified';
      trial.verificationDir = verified.dir;
    }
    if (trial.status === 'local-work-blocked') trial.error = result.report.nextStep;
    trials.push(trial);
  }
  const metrics = (['direct', 'harness'] as const).map(arm => {
    const selected = trials.filter(trial => trial.arm === arm);
    const n = selected.length;
    const correct = selected.filter(trial => trial.decision === gold[trial.id].decision).length;
    const wrongfulEdits = selected.filter(trial => trial.editTriggered && !gold[trial.id].patchable).length;
    const submitted = selected.filter(trial => trial.submittedPatch).length;
    const passed = selected.filter(trial => trial.independentPass).length;
    const patchable = selected.filter(trial => gold[trial.id].patchable).length;
    const passedPatchable = selected.filter(trial => gold[trial.id].patchable && trial.independentPass).length;
    return {arm, n, correct, wrongfulEdits, submitted, passed, patchable, passedPatchable};
  });
  const limitations = [
    'Six fixed cases, including one reconstructed historical review and five synthetic cases. No statistical significance claim.',
    'Both arms receive identical snapshot, repository files, target catalog, model/tool interface and per-call budget. Harness may decline a model call.',
    'Direct means the host applies the proposal with the same edit scope but no triage, regression gating, or delivery freshness check. The same independent verifier scores both arms.',
    'A wrongful edit is an attempted candidate application on authorization, old-failure, missing-dependency or updated cases. The updated fixture drifts at finalization, so distinguish speculative edits in an isolated worktree from patch delivery.',
    'Correct next step uses the preregistered decision category. For patchable cases the category is reproduce, including runs whose reproduction and verification already succeeded.',
    model ? 'The model run requires separately configured Pi provider credentials. See trial errors for unavailable invocations.' :
      'The deterministic mock proposes a fix even on unsuitable inputs. These results characterize Harness gates with this scripted baseline, not actual model quality.',
  ];
  await log.json('evaluation.json', {model: agent.label, budget: model ? piBudget : null, gold, metrics, trials, limitations});
  const table = metrics.map(m => '| ' + [m.arm, m.n, m.correct + '/' + m.n, m.wrongfulEdits,
    m.passed + '/' + m.submitted, m.passedPatchable + '/' + m.patchable].join(' | ') + ' |');
  await writeFile(join(log.dir, 'evaluation.md'), [
    '# ForkRecheck evaluation', '', 'Agent: ' + agent.label, '',
    '| Arm | Cases | Correct next step | Wrongful edit triggers | Independent pass/submitted | Independent pass/patchable |',
    '| --- | ---: | ---: | ---: | ---: | ---: |', ...table, '', '## Trials', '',
    ...trials.map(trial => '- ' + trial.id + ' / ' + trial.arm + ' · ' + trial.status + (trial.error ? ' · ' + trial.error : '') +
      ' · ' + resolve(trial.reportDir)), '', ...limitations.map(note => '- ' + note), '',
  ].join('\n'), {mode: 0o600});
  return {dir: log.dir, metrics, trials};
}
