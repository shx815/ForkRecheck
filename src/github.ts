import type { ChangedFile, Check, Review, Snapshot, Source, Version } from './evidence.ts';
import { checkBinding } from './evidence.ts';
import { message } from './process.ts';

const api = 'https://api.github.com';
const web = 'https://github.com';
const failed = ['failure', 'timed_out', 'startup_failure', 'error'];
const shaPattern = /^[0-9a-f]{40}$/;

export function parsePR(input: string) {
  const url = new URL(input);
  const match = url.pathname.match(/^\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)\/?$/);
  if (url.origin !== web || url.username || url.password || !match || !Number.isSafeInteger(Number(match[3])))
    throw new Error('Expected https://github.com/OWNER/REPO/pull/NUMBER');
  const repo = match[1] + '/' + match[2];
  return { owner: match[1], name: match[2], repo, number: Number(match[3]), url: web + '/' + repo + '/pull/' + match[3] };
}

type Ref = { sha: string; ref: string; repo?: { full_name: string } | null };
type PR = { state: 'open' | 'closed'; merged: boolean; draft: boolean; merge_commit_sha?: string | null; head: Ref; base: Ref; changed_files: number };
type RestReview = {
  id: number; html_url: string; body?: string; created_at?: string; submitted_at?: string;
  commit_id?: string; original_commit_id?: string; path?: string; line?: number | null;
  diff_hunk?: string; side?: string; state?: string; in_reply_to_id?: number;
};
type RunPR = { number: number; head: Ref; base: Ref };
type Run = {
  id: number; name: string; head_sha: string; head_branch: string; event: string; workflow_id: number;
  run_attempt: number; check_suite_id: number; html_url: string; status: string; conclusion: string | null;
  head_repository?: { full_name: string }; pull_requests?: RunPR[]; created_at?: string;
};

export function runAssociation(run: Run, version: Version, number: number) {
  const matching = run.pull_requests?.find(pr => pr.number === number);
  const eventOK = run.event === 'pull_request';
  if (run.pull_requests?.length && !matching) return { association: 'foreign' as const };
  // A stable merge ref proves the two parents. A PR tuple can additionally bind a head run to its base.
  const base = matching?.base.sha || (run.head_sha === version.merge ? version.base : undefined);
  if (!eventOK) return { association: 'unverified' as const, base };
  if (matching) {
    const matchesHead = matching.head.sha === version.head || matching.head.sha === run.head_sha;
    return {association: matchesHead ? 'matched' as const : 'unverified' as const, base};
  }
  if (version.fork && version.headRef && run.head_repository?.full_name === version.fork && run.head_branch === version.headRef &&
      (run.head_sha === version.head || run.head_sha === version.merge))
    return { association: 'matched' as const, base };
  return { association: 'unverified' as const, base };
}

export function authorizationBanner(html: string, prPath: string) {
  // GitHub's run page includes a server-rendered maintainer banner scoped to the PR.
  const banners = html.matchAll(/This workflow is\s*<strong>awaiting approval<\/strong>\s*from a maintainer in\s*<a\b([^>]{0,1200})>/gi);
  for (const banner of banners) {
    if (banner[1].match(/\bhref="([^"]+)"/)?.[1] === prPath)
      return 'GitHub Actions shows this workflow is awaiting maintainer approval for this PR.';
  }
  return undefined;
}

async function limited(response: Response, limit: number, prefix = false) {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      if (size + value.length > limit) {
        await reader.cancel();
        if (!prefix) throw new Error('Response exceeded ' + limit + ' bytes');
        chunks.push(value.subarray(0, limit - size));
        return Buffer.concat(chunks).toString() + '\n[truncated]';
      }
      chunks.push(value);
      size += value.length;
    }
  }
  return Buffer.concat(chunks).toString();
}

export class GitHub implements Source {
  readonly pr: ReturnType<typeof parsePR>;
  readonly token?: string;
  readonly root: string;
  readonly pull: string;
  readonly request: typeof fetch;

  constructor(input: string, token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN, request = fetch) {
    this.pr = parsePR(input);
    this.token = token;
    this.root = '/repos/' + this.pr.repo;
    this.pull = this.root + '/pulls/' + this.pr.number;
    this.request = request;
  }

  async apiResponse(path: string, init?: RequestInit) {
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (init?.body) headers['Content-Type'] = 'application/json';
    if (this.token) headers.Authorization = 'Bearer ' + this.token;
    const response = await this.request(api + path, { headers, redirect: 'manual', signal: AbortSignal.timeout(15_000), ...init });
    return response;
  }

  async json<T>(path: string, init?: RequestInit): Promise<{value: T; more: boolean}> {
    const response = await this.apiResponse(path, init);
    if (!response.ok) throw new Error(path.split('?')[0] + ' returned HTTP ' + response.status);
    return { value: JSON.parse(await limited(response, 12_000_000)) as T, more: /rel="next"/.test(response.headers.get('link') ?? '') };
  }

  async pages<T>(path: string, select: (data: unknown) => T[] = data => data as T[]) {
    const separator = path.includes('?') ? '&' : '?';
    const rows: T[] = [];
    for (let page = 1; page <= 10; page++) {
      const {value, more} = await this.json(path + separator + 'per_page=100&page=' + page);
      rows.push(...select(value));
      if (!more) return rows;
    }
    throw new Error(path.split('?')[0] + ' exceeded the 1,000-row collection limit');
  }

  async metadata() {
    const {value: pr} = await this.json<PR>(this.pull);
    if (!shaPattern.test(pr.head.sha) || !shaPattern.test(pr.base.sha)) throw new Error('GitHub returned invalid PR SHAs');
    const version: Version = {
      head: pr.head.sha, base: pr.base.sha, draft: pr.draft,
      state: pr.merged ? 'merged' : pr.state, fork: pr.head.repo?.full_name, headRef: pr.head.ref, baseRef: pr.base.ref,
    };
    return {version, pr};
  }

  async version() {
    return (await this.metadata()).version;
  }

  async resolutions() {
    type Threads = { nodes: { isResolved: boolean; isOutdated: boolean; comments: { nodes: { databaseId: number }[] } }[]; pageInfo: {hasNextPage: boolean; endCursor: string} };
    const query = 'query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){nodes{isResolved isOutdated comments(first:1){nodes{databaseId}}} pageInfo{hasNextPage endCursor}}}}}';
    const states = new Map<number, {resolved: boolean; outdated: boolean}>();
    let cursor: string | null = null;
    for (let page = 1; page <= 10; page++) {
      type GraphResponse = {data?: {repository?: {pullRequest?: {reviewThreads: Threads}}}; errors?: unknown[]};
      const {value}: {value: GraphResponse} = await this.json<GraphResponse>('/graphql', {
        method: 'POST', body: JSON.stringify({query, variables: {owner: this.pr.owner, name: this.pr.name, number: this.pr.number, cursor}}),
      });
      const threads: Threads | undefined = value.data?.repository?.pullRequest?.reviewThreads;
      if (value.errors?.length || !threads) throw new Error('GitHub GraphQL review thread state is unavailable');
      for (const thread of threads.nodes) {
        const first = thread.comments.nodes[0];
        if (first) states.set(first.databaseId, {resolved: thread.isResolved, outdated: thread.isOutdated});
      }
      if (!threads.pageInfo.hasNextPage) return states;
      cursor = threads.pageInfo.endCursor;
    }
    throw new Error('Review thread pagination limit reached');
  }

  async failureLogs(run: Run): Promise<NonNullable<Check['logs']>> {
    const url = this.pr.url.replace(/\/pull\/\d+$/, '/actions/runs/' + run.id);
    const jobsPath = this.root + '/actions/runs/' + run.id + '/attempts/' + run.run_attempt + '/jobs';
    const jobs = await this.pages<{id: number; html_url: string; conclusion: string}>(jobsPath, row => (row as {jobs: never[]}).jobs);
    const failures = jobs.filter(job => failed.includes(job.conclusion));
    if (!failures.length) return [{url, state: 'unavailable', reason: 'No failed jobs exposed for this attempt'}];
    const logs: NonNullable<Check['logs']> = [];
    for (const job of failures.slice(0, 6)) {
      try {
        let response = await this.apiResponse(this.root + '/actions/jobs/' + job.id + '/logs');
        const location = response.headers.get('location');
        if (response.status === 302 && location) {
          const target = new URL(location);
          if (target.protocol !== 'https:' || target.username || target.password) throw new Error('Unexpected log redirect');
          response = await this.request(target, {redirect: 'error', signal: AbortSignal.timeout(15_000)});
        }
        if (!response.ok) throw new Error('HTTP ' + response.status);
        logs.push({url: job.html_url, state: 'available', text: await limited(response, 32_000, true)});
      } catch (error) { logs.push({url: job.html_url, state: 'unavailable', reason: message(error)}); }
    }
    if (failures.length > 6) logs.push({ url, state: 'unavailable', reason: 'Failed job log collection limit reached' });
    return logs;
  }

  async snapshot(): Promise<Snapshot> {
    const collectedAt = new Date().toISOString();
    const {version, pr} = await this.metadata();
    const gaps: string[] = [];
    const notes: string[] = [
      'Actions API head_sha associates the run with a version. The workflow may choose a different checkout.',
      'Head-only checks without base metadata do not establish which base was tested.',
    ];
    let mergeCandidate: Snapshot['mergeCandidate'];
    async function collect<T>(label: string, task: () => Promise<T>, fallback: T) {
      try { return await task(); }
      catch (error) { gaps.push(label + ': ' + message(error)); return fallback; }
    }
    if (version.state === 'open' && pr.merge_commit_sha && shaPattern.test(pr.merge_commit_sha)) {
      const candidate = pr.merge_commit_sha;
      const parents = await collect('Synthetic merge parents', async () => {
        const {value} = await this.json<{parents: {sha: string}[]}>(this.root + '/git/commits/' + candidate);
        return value.parents.map(parent => parent.sha);
      }, []);
      mergeCandidate = {sha: candidate, parents};
      if (parents.length === 2 && parents[0] === version.base && parents[1] === version.head) version.merge = candidate;
      else gaps.push('GitHub merge SHA could not be verified as the current base + head.');
    } else if (version.state === 'open') {
      gaps.push('GitHub did not publish a verifiable synthetic merge SHA.');
    }

    const [fileRows, inline, submitted, conversation, resolutions] = await Promise.all([
      collect('PR diff', () => this.pages<{filename: string; patch?: string; previous_filename?: string}>(this.pull + '/files'), []),
      collect('Inline reviews', () => this.pages<RestReview>(this.pull + '/comments'), []),
      collect('Submitted reviews', () => this.pages<RestReview>(this.pull + '/reviews'), []),
      collect('Conversation comments', () => this.pages<RestReview>(this.root + '/issues/' + this.pr.number + '/comments'), []),
      this.token ? collect('Review resolution', () => this.resolutions(), undefined) : undefined,
    ]);
    if (!this.token && inline.length) notes.push('Anonymous REST does not expose review thread resolution.');
    if (fileRows.length !== pr.changed_files) gaps.push('PR file list is incomplete.');
    if (fileRows.some(row => !row.patch)) notes.push('GitHub omitted one or more file patch bodies.');
    const files: ChangedFile[] = fileRows.map(row => ({path: row.filename, patch: row.patch, previousPath: row.previous_filename}));
    const toReview = (row: RestReview, kind: Review['kind']): Review => {
      const codeLines = row.diff_hunk?.split('\n').filter(line => /^[ +\-]/.test(line));
      const last = codeLines?.at(-1);
      return {
        id: kind + '-' + row.id, url: row.html_url, body: row.body ?? '', at: row.created_at ?? row.submitted_at,
        kind, commit: row.commit_id, originalCommit: row.original_commit_id ?? row.commit_id, path: row.path,
        originalHunk: row.diff_hunk, line: row.line ?? undefined,
        anchor: last && row.side !== 'LEFT' && /^[ +]/.test(last) ? last.slice(1) : undefined,
        outdated: resolutions?.get(row.in_reply_to_id ?? row.id)?.outdated ?? (kind === 'inline' ? row.line == null : undefined),
        resolved: resolutions?.get(row.in_reply_to_id ?? row.id)?.resolved ?? (row.state === 'DISMISSED' ? true : undefined),
      };
    };
    const reviews = [
      ...inline.map(row => toReview(row, row.in_reply_to_id ? 'conversation' : 'inline')),
      ...submitted.filter(row => row.state !== 'PENDING').map(row => toReview(row, 'review')),
      ...conversation.map(row => toReview(row, 'conversation')),
    ];
    // Include reviewed older heads so old failures remain visible without treating them as current.
    const old = [...new Set(reviews.map(review => review.originalCommit).filter((sha): sha is string =>
      !!sha && shaPattern.test(sha) && sha !== version.head && sha !== version.merge))];
    if (old.length > 3) notes.push('Check history sampled at up to three older reviewed commits.');
    const shaList = [version.head, ...(version.merge ? [version.merge] : []), ...old.slice(0, 3)];
    const checks: Check[] = [];
    const runs = new Map<number, Run>();
    const checkRows: {id: number; name: string; html_url: string; details_url?: string; head_sha: string; status: string; conclusion?: string; check_suite?: {id: number}; app?: {slug: string}}[] = [];
    for (const sha of shaList) {
      const [workflowRows, suiteRows, statuses] = await Promise.all([
        collect('Actions runs ' + sha, () => this.pages<Run>(this.root + '/actions/runs?head_sha=' + sha, row => (row as {workflow_runs: Run[]}).workflow_runs), []),
        collect('Check runs ' + sha, () => this.pages<(typeof checkRows)[number]>(
          this.root + '/commits/' + sha + '/check-runs?filter=latest', row => (row as {check_runs: typeof checkRows}).check_runs), []),
        collect('Commit statuses ' + sha, () => this.pages<{id: number; context: string; state: string; target_url?: string}>(this.root + '/commits/' + sha + '/statuses'), []),
      ]);
      workflowRows.forEach(run => runs.set(run.id, run));
      checkRows.push(...suiteRows);
      const latest = new Set<string>();
      for (const status of statuses) {
        checks.push({
          id: 'status-' + status.id, name: status.context, url: status.target_url || this.pr.url + '/checks',
          kind: 'status', status: status.state, conclusion: status.state === 'pending' ? undefined : status.state,
          sha, historical: old.includes(sha), base: sha === version.merge ? version.base : undefined, superseded: latest.has(status.context),
        });
        latest.add(status.context);
      }
    }

    const actionSuites = new Set([...runs.values()].filter(run => run.event === 'pull_request').map(run => run.check_suite_id));
    for (const row of checkRows) {
      // Current Actions semantics come from the run record, not its duplicate check rows.
      checks.push({
        id: 'check-' + row.id, name: row.name, url: row.html_url || row.details_url || this.pr.url + '/checks', kind: 'check',
        sha: row.head_sha, historical: old.includes(row.head_sha), base: row.head_sha === version.merge ? version.base : undefined,
        status: row.status, conclusion: row.conclusion ?? undefined, superseded: actionSuites.has(row.check_suite?.id ?? 0),
        association: row.app?.slug === 'github-actions' ? 'unverified' : undefined,
      });
    }
    const currentRuns = new Set<string>();
    const actionChecks: {check: Check; run: Run}[] = [];
    const historicalActions: {check: Check; run: Run}[] = [];
    for (const run of [...runs.values()].sort((a, b) => b.id - a.id)) {
      const check: Check = {
        id: 'actions-' + run.id, name: run.name, url: web + '/' + this.pr.repo + '/actions/runs/' + run.id,
        sha: run.head_sha, kind: 'actions', status: run.status, conclusion: run.conclusion ?? undefined,
        historical: old.includes(run.head_sha),
        run: {event: run.event, attempt: run.run_attempt, reportedSha: run.head_sha, headRef: run.head_branch,
          headRepository: run.head_repository?.full_name, prNumber: run.pull_requests?.find(pr => pr.number === this.pr.number)?.number},
        ...runAssociation(run, version, this.pr.number),
      };
      const binding = checkBinding(check, version);
      const key = run.workflow_id + '/' + binding;
      if (binding === 'head' || binding === 'merge') {
        check.superseded = currentRuns.has(key);
        currentRuns.add(key);
      }
      checks.push(check);
      if (!check.superseded && (binding === 'head' || binding === 'merge')) actionChecks.push({check, run});
      if (binding === 'historical' && runAssociation(run, {...version, head: run.head_sha}, this.pr.number).association === 'matched')
        historicalActions.push({check, run});
    }

    const awaiting = actionChecks.filter(({check}) => ['action_required', 'waiting'].includes(check.conclusion ?? check.status));
    if (awaiting.length > 8) notes.push('Maintainer approval page verification sampled at up to eight current Actions runs.');
    for (const group of [awaiting.slice(0, 4), awaiting.slice(4, 8)]) {
      await Promise.all(group.map(({check}) => collect('Actions approval evidence ' + check.id, async () => {
        const response = await this.request(check.url, {redirect: 'error', signal: AbortSignal.timeout(10_000)});
        if (!response.ok) throw new Error('GitHub run page HTTP ' + response.status);
        const text = authorizationBanner(await limited(response, 2_000_000), new URL(this.pr.url).pathname);
        if (text) check.authorization = {url: check.url, text};
      }, undefined)));
    }
    const failures = [...actionChecks, ...historicalActions].filter(({check}) => failed.includes(check.conclusion ?? ''));
    for (const [index, {check, run}] of failures.entries()) {
      check.logs = index < 8
        ? await collect('Actions job logs ' + check.id, () => this.failureLogs(run), [{url: check.url, state: 'unavailable', reason: 'Job metadata inaccessible'}])
        : [{url: check.url, state: 'unavailable', reason: 'Failed run log collection limit reached'}];
    }
    for (const check of checks) {
      if (!check.superseded && failed.includes(check.conclusion ?? '') && !check.logs) {
        check.logs = [{url: check.url, state: 'unavailable', reason: 'No version-bound Actions job log retrieved for this check'}];
      }
    }
    const endVersion = await collect('PR version recheck', () => this.version(), undefined);
    return {url: this.pr.url, origin: 'github', collectedAt, mergeCandidate, version, endVersion, files, reviews, checks, gaps, notes};
  }
}
