import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Agent, Proposal } from './agent.ts';
import type { ChangedFile, Check, Review, Snapshot, Source, Version } from './evidence.ts';
import { createFixtureRepo, loadConfig, requiredGit } from './local.ts';
import { shellCommand } from './process.ts';
import { run, verifyCommand } from './workflow.ts';

export const cases = ['verl', 'fix', 'authorization', 'old-failure', 'missing-dependency', 'updated'] as const;
export type Case = typeof cases[number];
export const fixtures = new URL('../fixtures/', import.meta.url);
const synthetic = 'https://github.com/example/fork-recheck-fixture/pull/42';

function parsePatch(diff: string): ChangedFile[] {
  return diff.split(/^diff --git /m).slice(1).flatMap(file => {
    const path = file.match(/^\+\+\+ b\/(.+)$/m)?.[1];
    const start = file.indexOf('\n@@');
    return path ? [{path, patch: start >= 0 ? file.slice(start + 1) : undefined}] : [];
  });
}

export function fixtureCase(input: string): Case {
  if (!(cases as readonly string[]).includes(input)) throw new Error('Unknown replay case. Choose ' + cases.join(', '));
  return input as Case;
}

type History = {url: string; cutoff: string; capturedAt: string; head: string; base: string; previousHead: string; reviews: Review[]; blobIds: Record<string, string>};

export async function withReplay<T>(id: Case, action: (data: {
  repo: string; head: string; source: Source; config: Awaited<ReturnType<typeof loadConfig>>;
}) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), 'fork-recheck-replay-'));
  try {
    const historical = id === 'verl';
    const fixtureDir = new URL(historical ? 'verl/' : 'synthetic/', fixtures);
    const config = await loadConfig(fileURLToPath(new URL('config.json', fixtureDir)));
    const repo = join(dir, 'repo');
    const head = await createFixtureRepo(repo, historical ? fileURLToPath(new URL('checkout/', fixtureDir)) : undefined);
    const date = '2026-11-12T00:00:00Z';
    let snapshot: Snapshot;
    if (historical) {
      const history = JSON.parse(await readFile(new URL('evidence.json', fixtureDir), 'utf8')) as History;
      for (const [path, expected] of Object.entries(history.blobIds)) {
        const blob = (await requiredGit(repo, ['hash-object', '--', path])).trim();
        if (blob !== expected) throw new Error('Historical fixture blob mismatch: ' + path);
      }
      const version: Version = {head: history.head, base: history.base, state: 'open', draft: false,
        fork: 'shx815/verl', headRef: 'codex/fix-math-dapo-multi-assignment', baseRef: 'main'};
      snapshot = {
        origin: 'historical', url: history.url, collectedAt: history.capturedAt, asOf: history.cutoff, version, endVersion: version,
        files: parsePatch(await readFile(new URL('pr.diff', fixtureDir), 'utf8')), reviews: history.reviews, checks: [],
        gaps: ['Historical cutoff reconstructed from public review timestamps and local Git objects. Historical CI was not captured.'],
        notes: [
          'Source commit: ' + history.url + '/commits/' + history.head,
          'Checkout is a replay repository with verified historical file blobs.',
          'The isolated runner and combined examples were authored for this replay.',
        ],
      };
    } else {
      const version: Version = {head, base: 'b'.repeat(40), state: 'open', draft: false, fork: 'contributor/fixture'};
      const reviews: Review[] = [{
        id: 'review-first-value', url: synthetic + '#discussion_r1', kind: 'inline', originalCommit: head,
        path: 'score.js', at: date, body: 'Differing first elements compare equal when the last element matches.',
      }];
      const checks: Check[] = [];
      if (id === 'authorization') {
        const url = 'https://github.com/example/fork-recheck-fixture/actions/runs/2';
        checks.push({id: 'run-auth', name: 'CI', kind: 'actions', sha: head, url, status: 'completed',
          conclusion: 'action_required', association: 'matched', authorization: {url, text: 'Synthetic maintainer approval banner'}});
      }
      if (id === 'old-failure') {
        checks.push({id: 'run-older', name: 'CI', kind: 'actions', sha: 'c'.repeat(40),
          url: 'https://github.com/example/fork-recheck-fixture/actions/runs/1',
          status: 'completed', conclusion: 'failure', historical: true, association: 'matched'});
        reviews[0].originalCommit = 'c'.repeat(40);
        reviews[0].outdated = true;
        reviews[0].anchor = 'superseded source';
      }
      if (id === 'missing-dependency') {
        const target = config.targets[0];
        target.setup = ['fork-recheck-fixture-binary-intentionally-absent'];
        target.requires.push('fixture dependency executable');
      }
      snapshot = {
        origin: 'synthetic', url: synthetic, collectedAt: date, version, endVersion: version,
        files: [{path: 'score.js', patch: '@@ -1 +1 @@\n+export const score = (a, b) => a.at(-1) === b.at(-1);'}],
        reviews, checks, gaps: [], notes: ['Fixed synthetic evidence for offline replay.'],
      };
    }
    const source: Source = {
      snapshot: async () => structuredClone(snapshot),
      version: async () => id === 'updated' ? {...snapshot.version, base: 'd'.repeat(40)} : structuredClone(snapshot.version),
    };
    return await action({repo, head, config, source});
  } finally { await rm(dir, {recursive: true, force: true}); }
}

export const mockAgent: Agent = {
  label: 'deterministic mock proposal',
  async propose({snapshot, cwd}, record) {
    let proposal: Proposal;
    if (snapshot.origin === 'historical') {
      const path = 'verl/utils/reward_score/math_dapo.py';
      const contents = await readFile(join(cwd, path), 'utf8');
      const old = contents.split('\n').find(line => line.includes('final_answer.replace("$", "")') && line.includes('r"='));
      if (!old) throw new Error('Missing expected historical edit context');
      const anchor = '    has_multiple_assignments = re.search(\n';
      const newAnchor = '    detection_input = final_answer.replace("$", "").replace(" ", "")\n' +
        '    detection_input = detection_input.replace(r",\\text{and}", ",").replace(r"\\text{and}", ",")\n' + anchor;
      proposal = {
        decision: 'reproduce', target: 'assignment-separator', evidence: ['inline-4554055009'],
        edits: [
          {path, old: anchor, replacement: newAnchor},
          {path, old, replacement: old.replace('final_answer.replace("$", "")', 'detection_input')},
        ],
        summary: 'Use the separator regression to check assignment collapse. Normalize the separator before detecting multiple assignments.',
      };
    } else {
      // Deliberately optimistic fixed policy. Used identically by both evaluation arms.
      proposal = {
        decision: 'reproduce', target: 'first-value', evidence: ['review-first-value'],
        edits: [{path: 'score.js', old: 'a.at(-1) === b.at(-1)', replacement: 'a.length === b.length && a.every((value, i) => value === b[i])'}],
        summary: 'Compare every array element in the configured regression.',
      };
    }
    await record({type: 'mock', response: proposal});
    return proposal;
  },
};

export async function replay(id: Case, output: string, agent = mockAgent, model?: string) {
  return withReplay(id, data => run({
    ...data, output, fixture: id, agent,
    rerun: shellCommand(['fork-recheck', 'replay', id, '--out', output, ...(model ? ['--model', model] : [])]),
    verifyCommand: dir => verifyCommand(dir),
  }));
}

