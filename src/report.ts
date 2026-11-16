import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Proposal } from './agent.ts';
import type { Decision, Snapshot, Version } from './evidence.ts';
import { triage } from './evidence.ts';
import type { TestRecord } from './local.ts';

export type PatchManifest = {
  schema: 1; url: string; version: Version; checkoutHead: string; sha256: string;
  configHash: string; target: string; testHashes: Record<string, string>; fixture?: string;
};

export type Report = {
  schema: 1; runId: string; generatedAt: string; snapshot: Snapshot; assessment: ReturnType<typeof triage>;
  decision: Decision; state: string; nextStep: string; finalVersion?: Version; freshness: 'current' | 'stale' | 'unverified' | 'fixture';
  checkoutHead?: string; config?: string; proposal?: Proposal; model?: string; tests: TestRecord[]; uncovered: string[];
  patch?: PatchManifest; rerun: string; verify?: string;
};

const clean = (value: unknown) => String(value ?? '').replace(/[\r\n]/g, ' ').replaceAll('|', '\\|').replaceAll('<', '&lt;');
const link = (input: string) => {
  try {
    const url = new URL(input);
    return url.protocol === 'https:' && !url.username && !url.password ? '<' + url.href.replaceAll('>', '%3E') + '>' : clean(input);
  } catch { return clean(input); }
};

export function markdown(report: Report) {
  const {snapshot, assessment} = report;
  const lines = [
    '# ForkRecheck', '', 'PR ' + link(snapshot.url), '',
    '- Snapshot origin: ' + snapshot.origin,
    '- Collected: ' + snapshot.collectedAt,
    ...(snapshot.asOf ? ['- Historical evidence cutoff: ' + snapshot.asOf] : []),
    '- Head: `' + snapshot.version.head + '`',
    '- Base: `' + snapshot.version.base + '`',
    '- Verified merge SHA: ' + (snapshot.version.merge ?? 'unknown'),
    ...(!snapshot.version.merge && snapshot.mergeCandidate ? ['- Unverified merge candidate: ' + snapshot.mergeCandidate.sha +
      ' (parents ' + (snapshot.mergeCandidate.parents.join(' / ') || 'unavailable') + ')'] : []),
    '- Checkout: ' + (report.checkoutHead ?? 'none'),
    '- Final head/base: ' + (report.finalVersion ? report.finalVersion.head + ' / ' + report.finalVersion.base : 'unverified'),
    '- Freshness: **' + report.freshness + '**',
    '- Assessment: **' + assessment.decision + '**. ' + assessment.reason,
    '- State: **' + report.state + '**',
    '- Next step: ' + clean(report.nextStep), '', '## Evidence and scope', '',
    '- PR diff: ' + link(snapshot.url + '/files'),
    ...assessment.urls.map(url => '- ' + link(url)),
    ...[...snapshot.gaps, ...(snapshot.notes ?? []), ...report.uncovered].map(note => '- ' + clean(note)),
    '', '### Reviews', '',
    ...assessment.reviews.map(review => '- ' + clean(review.id) + ' · ' + review.applicability + ' · ' +
      (review.originalCommit ?? 'unbound') + (review.at ? ' · ' + review.at : '') + ' · ' + link(review.url)),
    '', '### Checks', '',
    '| Check | Version binding | Status | Evidence |', '| --- | --- | --- | --- |',
    ...assessment.checks.map(check => '| ' + clean(check.name) + ' | ' + check.binding + ' ' + (check.sha?.slice(0, 12) ?? '') +
      (check.superseded ? ' · superseded' : '') + ' | ' + clean(check.conclusion ?? check.status) + ' | ' +
      link(check.url) + (check.authorization ? ' · maintainer approval' : '') +
      (check.logs ? ' · ' + check.logs.map(log => log.state + ' ' + link(log.url) + (log.reason ? ' (' + clean(log.reason) + ')' : '')).join(', ') : '') + ' |'),
    '', '## Local tests', '',
  ];
  for (const test of report.tests) {
    lines.push('- **' + test.phase + ' / ' + test.target + '** · ' + test.kind +
      ' · exit ' + (test.execution?.exitCode ?? test.setup?.exitCode ?? 'n/a') +
      ' · ' + clean(test.platform + ' ' + test.hardware) + ' · ' + (test.patchHash ?? test.version));
    if (test.setupCommand) lines.push('  - Setup: ' + clean(test.setupCommand));
    lines.push('  - Command: ' + clean(test.command) + ' · timeout ' + test.timeoutMs + ' ms');
    if (test.requires.length) lines.push('  - Dependencies: ' + clean(test.requires.join(', ')));
    const output = (test.reason || test.execution?.output || test.execution?.error || test.setup?.output || test.setup?.error || '').trim().slice(0, 500);
    if (output) lines.push('  - Output: ' + clean(output));
  }
  if (!report.tests.length) lines.push('No local tests ran.');
  if (report.model) lines.push('', 'Agent: ' + clean(report.model) + '. See agent.jsonl for the proposal and transcript.');
  if (report.patch) lines.push('', 'Patch: [patch.diff](patch.diff)', '', 'SHA-256: `' + report.patch.sha256 + '`');
  const commands = [report.rerun, report.verify].filter(Boolean);
  lines.push('', '## Re-run', '', '```sh', ...commands as string[], '```', '');
  return lines.join('\n');
}

export async function runLog(output: string) {
  const root = resolve(output);
  await mkdir(root, {recursive: true, mode: 0o700});
  const dir = await mkdtemp(join(root, 'run-'));
  const event = (stage: string, detail?: unknown) =>
    appendFile(join(dir, 'events.jsonl'), JSON.stringify({at: new Date().toISOString(), stage, detail}) + '\n', {mode: 0o600});
  const agent = (detail: unknown) =>
    appendFile(join(dir, 'agent.jsonl'), JSON.stringify({at: new Date().toISOString(), detail}) + '\n', {mode: 0o600});
  const json = (name: string, data: unknown) =>
    writeFile(join(dir, name), JSON.stringify(data, null, 2) + '\n', {mode: 0o600});
  const finish = async (report: Report) => {
    await json('report.json', report);
    await writeFile(join(dir, 'report.md'), markdown(report), {mode: 0o600});
  };
  return {dir, event, agent, json, finish};
}
