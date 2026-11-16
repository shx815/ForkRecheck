export type Version = {
  head: string;
  base: string;
  merge?: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  fork?: string;
  headRef?: string;
  baseRef?: string;
};

export type ChangedFile = { path: string; patch?: string; previousPath?: string };
export type Review = {
  id: string; url: string; body: string; at?: string; originalCommit?: string;
  commit?: string; path?: string; anchor?: string; originalHunk?: string; line?: number; outdated?: boolean;
  resolved?: boolean; kind: 'inline' | 'review' | 'conversation';
};
export type Check = {
  id: string; name: string; url: string; sha?: string; base?: string; status: string;
  conclusion?: string; kind: 'actions' | 'check' | 'status';
  association?: 'matched' | 'foreign' | 'unverified';
  authorization?: { url: string; text: string };
  logs?: { url: string; state: 'available' | 'unavailable'; text?: string; reason?: string }[];
  superseded?: boolean;
  historical?: boolean;
  run?: {event: string; attempt: number; reportedSha: string; headRef: string; headRepository?: string; prNumber?: number};

};
export type Snapshot = {
  url: string; collectedAt: string; origin: 'github' | 'historical' | 'synthetic';
  asOf?: string; mergeCandidate?: {sha: string; parents: string[]};
  version: Version; endVersion?: Version; files: ChangedFile[];
  reviews: Review[]; checks: Check[]; gaps: string[]; notes?: string[];
};
export type Source = {
  snapshot(): Promise<Snapshot>;
  version(): Promise<Version>;
};

export function sameVersion(a: Version, b: Version) {
  return a.head === b.head && a.base === b.base && a.state === b.state && a.draft === b.draft &&
    a.fork === b.fork && a.headRef === b.headRef && a.baseRef === b.baseRef;
}

export function reviewApplicability(review: Review, snapshot: Snapshot) {
  if (review.resolved) return 'resolved';
  if (review.kind === 'conversation' || !review.originalCommit) return 'unbound';
  if (review.originalCommit === snapshot.version.head && !review.outdated) return 'current';
  const file = snapshot.files.find(({path}) => path === review.path);
  if (file?.patch && review.anchor) {
    const hunkLines = file.patch.split('\n')
      .filter(line => line.startsWith(' ') || (line.startsWith('+') && !line.startsWith('+++')))
      .map(line => line.slice(1).trim());
    if (hunkLines.includes(review.anchor.trim())) return 'older-anchor-present';
  }
  return 'older-unconfirmed';
}

export function checkBinding(check: Check, version: Version) {
  if (check.association === 'foreign') return 'foreign';
  if (check.historical && check.sha !== version.head && check.sha !== version.merge) return 'historical';
  if (!check.sha || check.association === 'unverified') return 'uncertain';
  if (check.sha === version.head) {
    if (check.base && check.base !== version.base) return 'historical';
    return 'head';
  }
  if (check.sha === version.merge && check.base === version.base) return 'merge';
  return 'uncertain';
}

export const decisions = [
  'reproduce', 'request-authorization', 'inspect-failure', 'await-checks',
  'refresh-evidence', 'review-status', 'restore-environment', 'closed', 'stale',
] as const;
export type Decision = typeof decisions[number];

export function triage(snapshot: Snapshot) {
  const reviews = snapshot.reviews.map(review => ({
    ...review, applicability: reviewApplicability(review, snapshot),
  }));
  const checks = snapshot.checks.map(check => ({
    ...check, binding: checkBinding(check, snapshot.version),
  }));
  const active = checks.filter(check => !check.superseded && (check.binding === 'head' || check.binding === 'merge'));
  const failed = active.filter(check => ['failure', 'error', 'startup_failure', 'timed_out'].includes(check.conclusion ?? ''));
  const authorized = active.filter(check => check.kind === 'actions' && check.authorization &&
    ['action_required', 'waiting'].includes(check.conclusion ?? check.status));
  const ambiguous = active.filter(check => ['action_required', 'waiting', 'neutral', 'stale', 'cancelled'].includes(check.conclusion ?? check.status));
  const pending = active.filter(check => ['queued', 'in_progress', 'requested', 'pending'].includes(check.status));
  const candidates = reviews.filter(review => review.body.trim() && ['current', 'older-anchor-present'].includes(review.applicability));
  let decision: Decision;
  let reason: string;
  let urls: string[] = [];
  if (!snapshot.endVersion || !sameVersion(snapshot.version, snapshot.endVersion)) {
    decision = 'stale'; reason = 'PR version changed during collection or could not be rechecked.';
  } else if (snapshot.version.state !== 'open') {
    decision = 'closed'; reason = 'PR is ' + snapshot.version.state + '.';
  } else if (failed.length) {
    decision = 'inspect-failure';
    reason = 'A current check failed. Inspect the recorded logs and reproduce a specific behavior before editing.';
    urls = failed.map(check => check.url);
  } else if (authorized.length) {
    decision = 'request-authorization'; reason = 'GitHub Actions reports the fork run requires maintainer approval.';
    urls = authorized.map(check => check.authorization!.url);
  } else if (ambiguous.length) {
    decision = 'refresh-evidence'; reason = 'A current check has a non-success state with ambiguous cause.';
    urls = ambiguous.map(check => check.url);
  } else if (candidates.length) {
    decision = 'reproduce'; reason = 'Review feedback is bound to the current head or its original anchor appears in the current diff. Local reproduction is required.';
    urls = candidates.map(review => review.url);
  } else if (pending.length) {
    decision = 'await-checks'; reason = 'A current check is still running or queued.'; urls = pending.map(check => check.url);
  } else if (!active.length || snapshot.gaps.length || checks.some(check => check.binding === 'uncertain' && !check.superseded)) {
    decision = 'refresh-evidence'; reason = 'Current check or review evidence is incomplete. Older failures do not establish a current failure.';
  } else {
    decision = 'review-status'; reason = 'Available current checks contain no actionable local failure. Review remaining merge requirements on GitHub.';
  }
  return { decision, reason, urls: [...new Set(urls.length ? urls : [snapshot.url])], reviews, checks };
}
