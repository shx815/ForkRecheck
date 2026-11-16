import assert from 'node:assert/strict';
import test from 'node:test';
import { checkBinding, reviewApplicability, triage } from '../src/evidence.ts';
import type { Check, Snapshot, Version } from '../src/evidence.ts';
import { authorizationBanner, GitHub, parsePR, runAssociation } from '../src/github.ts';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const merge = 'c'.repeat(40);
const older = 'd'.repeat(40);
const url = 'https://github.com/owner/repo/pull/1';
const version: Version = {head, base, merge, state: 'open', draft: false, fork: 'author/fork', headRef: 'topic', baseRef: 'main'};
const failure: Check = {id: '1', name: 'CI', url, sha: head, kind: 'actions', status: 'completed', conclusion: 'failure'};
const fixture: Snapshot = {
  url, collectedAt: '2026-11-12T00:00:00Z', origin: 'synthetic', version, endVersion: version,
  files: [{path: 'score.py', patch: '@@ -1 +1 @@\n-old code\n+original code'}], checks: [], reviews: [], gaps: [],
};

test('only confirmed histories are historical; merge requires the matching base', () => {
  assert.equal(checkBinding(failure, version), 'head');
  assert.equal(checkBinding({...failure, sha: older, historical: true}, version), 'historical');
  assert.equal(checkBinding({...failure, sha: older}, version), 'uncertain');
  assert.equal(checkBinding({...failure, sha: merge}, version), 'uncertain');
  assert.equal(checkBinding({...failure, sha: merge, base}, version), 'merge');
  assert.equal(checkBinding({...failure, sha: head, base: older}, version), 'historical');
  assert.equal(triage({...fixture, checks: [{...failure, sha: older, historical: true}]}).decision, 'refresh-evidence');
});

test('authorization requires a matched Actions run and PR-specific evidence', () => {
  const html = 'This workflow is <strong>awaiting approval</strong> from a maintainer in <a class="link" href="/owner/repo/pull/1">#1</a>';
  assert.ok(authorizationBanner(html, '/owner/repo/pull/1'));
  assert.equal(authorizationBanner(html, '/owner/repo/pull/2'), undefined);
  const check: Check = {...failure, conclusion: 'action_required'};
  assert.equal(triage({...fixture, checks: [check]}).decision, 'refresh-evidence');
  const gated = {...check, authorization: {url, text: 'Awaiting maintainer approval'}};
  assert.equal(triage({...fixture, checks: [gated]}).decision, 'request-authorization');
  assert.equal(triage({...fixture, checks: [gated, failure]}).decision, 'inspect-failure');
  assert.equal(triage({...fixture, checks: [{...gated, association: 'foreign'}]}).decision, 'refresh-evidence');
  assert.equal(triage({...fixture, checks: [{...gated, kind: 'check'}]}).decision, 'refresh-evidence');
});

test('original review SHA and current diff determine applicability', () => {
  const review = {id: 'r', url, body: 'Wrong behavior', kind: 'inline' as const, originalCommit: older, path: 'score.py'};
  assert.equal(reviewApplicability({...review, commit: head, anchor: 'old code'}, fixture), 'older-unconfirmed');
  assert.equal(reviewApplicability({...review, anchor: 'original code'}, fixture), 'older-anchor-present');
  assert.equal(reviewApplicability({...review, originalCommit: head}, fixture), 'current');
  assert.equal(reviewApplicability({...review, originalCommit: head, resolved: true}, fixture), 'resolved');
  assert.equal(triage({...fixture, reviews: [{...review, anchor: 'original code'}]}).decision, 'reproduce');
});

test('PR version bracket detects both head and base drift', () => {
  assert.equal(triage({...fixture, endVersion: {...version, head: older}}).decision, 'stale');
  assert.equal(triage({...fixture, endVersion: {...version, base: older}}).decision, 'stale');
  assert.equal(triage({...fixture, endVersion: undefined}).decision, 'stale');
});

test('GitHub URL and Actions associations', () => {
  assert.equal(parsePR(url + '#discussion_r1').url, url);
  assert.throws(() => parsePR('https://github.com.evil/owner/repo/pull/1'));
  assert.throws(() => parsePR('https://user@github.com/owner/repo/pull/1'));
  const run = {
    id: 42, name: 'CI', head_sha: head, head_branch: 'topic', event: 'pull_request', workflow_id: 1, run_attempt: 2,
    check_suite_id: 1, html_url: '', status: 'completed', conclusion: 'success', head_repository: {full_name: version.fork!},
  };
  assert.equal(runAssociation(run, version, 1).association, 'matched');
  assert.equal(runAssociation({...run, event: 'push'}, version, 1).association, 'unverified');
  assert.equal(runAssociation({...run, head_repository: {full_name: 'other/fork'}}, version, 1).association, 'unverified');
  const ref = (sha: string) => ({sha, ref: 'topic'});
  assert.equal(runAssociation({...run, pull_requests: [{number: 2, head: ref(head), base: ref(base)}]}, version, 1).association, 'foreign');
  assert.equal(runAssociation({...run, head_sha: merge}, version, 1).base, base);
});

test('REST adapter reads exact version, checks/logs, review history and PR-specific approval', async () => {
  let versions = 0;
  const visited: string[] = [];
  const request: typeof fetch = async (input, init) => {
    const parsed = new URL(input.toString());
    const path = parsed.pathname;
    visited.push(path);
    const data = (value: unknown) => Response.json(value);
    if (parsed.hostname === 'cdn.example') {
      assert.equal(new Headers(init?.headers).has('authorization'), false);
      return new Response('AssertionError: business rule');
    }
    if (parsed.hostname === 'github.com') {
      assert.equal(new Headers(init?.headers).has('authorization'), false);
      assert.match(path, /\/actions\/runs\/2$/);
      return new Response('This workflow is <strong>awaiting approval</strong> from a maintainer in <a href="/owner/repo/pull/1">#1</a>');
    }
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-read-token');
    if (path === '/graphql') {
      assert.equal(init?.method, 'POST');
      assert.equal(new Headers(init?.headers).get('content-type'), 'application/json');
      const payload = JSON.parse(String(init?.body));
      assert.match(payload.query, /^query\(/);
      assert.equal(payload.variables.number, 1);
      return data({data: {repository: {pullRequest: {reviewThreads: {
        nodes: [{isResolved: true, isOutdated: true, comments: {nodes: [{databaseId: 4}]}}],
        pageInfo: {hasNextPage: false},
      }}}}});
    }
    assert.equal(init?.method, undefined);
    if (path.endsWith('/pulls/1')) {
      versions++;
      return data({head: {sha: head, ref: 'topic', repo: {full_name: version.fork}}, base: {sha: base, ref: 'main'},
        state: 'open', draft: false, merged: false, merge_commit_sha: merge, changed_files: 1});
    }
    if (path.endsWith('/git/commits/' + merge)) return data({parents: [{sha: base}, {sha: head}]});
    if (path.endsWith('/files')) return data([{filename: 'score.py', patch: '@@ -1 +1 @@\n+original code'}]);
    if (path.endsWith('/pulls/1/comments')) return data([{id: 4, html_url: url, path: 'score.py', body: 'Bug',
      line: 3, diff_hunk: '@@ -1 +3 @@\n+original code', commit_id: head, original_commit_id: older}]);
    if (path.endsWith('/comments') || path.endsWith('/reviews')) return data([]);
    if (path.endsWith('/statuses')) return data([]);
    if (path.endsWith('/check-runs')) return data({check_runs: []});
    if (path.endsWith('/actions/runs')) {
      const sha = parsed.searchParams.get('head_sha');
      return data({workflow_runs: sha === older ? [] : [{
        id: sha === merge ? 3 : 2, name: 'CI', head_sha: sha, head_branch: 'topic', event: 'pull_request',
        head_repository: {full_name: version.fork}, workflow_id: 5, run_attempt: 3, check_suite_id: 5,
        status: 'completed', conclusion: sha === merge ? 'failure' : 'action_required', pull_requests: [],
      }]});
    }
    if (path.endsWith('/run/3')) throw new Error('unexpected run endpoint');
    if (path.endsWith('/runs/3/attempts/3/jobs')) return data({jobs: [{id: 44, conclusion: 'failure', html_url: url}]});
    if (path.endsWith('/jobs/44/logs')) return new Response(null, {status: 302, headers: {location: 'https://cdn.example/job'}});
    assert.fail('Unexpected path: ' + path);
  };
  const snapshot = await new GitHub(url, 'fixture-read-token', request).snapshot();
  assert.equal(versions, 2);
  assert.equal(snapshot.version.merge, merge);
  assert.equal(snapshot.reviews[0].originalCommit, older);
  assert.equal(snapshot.reviews[0].resolved, true);
  const assessment = triage(snapshot);
  assert.equal(assessment.decision, 'inspect-failure');
  assert.equal(assessment.checks.find(check => check.id === 'actions-2')?.authorization?.url, 'https://github.com/owner/repo/actions/runs/2');
  const bound = assessment.checks.find(check => check.id === 'actions-3');
  assert.equal(bound?.binding, 'merge');
  assert.match(bound?.logs?.[0].text ?? '', /business rule/);
  assert.ok(visited.includes('/repos/owner/repo/commits/' + older + '/statuses'));
});
