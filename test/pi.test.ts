import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { piAgent } from '../src/agent.ts';
import { withWorktree } from '../src/local.ts';
import { withReplay } from '../src/replay.ts';

test('pinned Pi SDK consumes simulated provider output and exposes only the guarded read tool', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fork-recheck-pi-test-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, {recursive: true, force: true});
  });
  await writeFile(join(dir, 'models.json'), JSON.stringify({
    providers: {
      fixture: {baseUrl: 'https://pi-fixture.example/v1', api: 'openai-completions', apiKey: 'local-fixture',
        models: [{id: 'fixed', maxTokens: 4096, contextWindow: 32768}]},
    },
  }));
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    assert.equal(url.origin, 'https://pi-fixture.example');
    assert.equal(url.pathname, '/v1/chat/completions');
    const payload = JSON.parse(String(init?.body ?? await (input as Request).text()));
    assert.deepEqual(payload.tools.map((tool: {function: {name: string}}) => tool.function.name), ['read_tracked_file']);
    const first = ++calls === 1;
    if (!first) assert.match(JSON.stringify(payload.messages), /export const score/);
    const chunks = [
      {delta: {role: 'assistant'}, finish_reason: null},
      first
        ? {delta: {tool_calls: [{index: 0, id: 'fixture-call', type: 'function',
          function: {name: 'read_tracked_file', arguments: '{"path":"score.js"}'}}]}, finish_reason: null}
        : {delta: {content: '{"decision":"reproduce","target":"first-value","evidence":["review-first-value"],"edits":[],"summary":"simulated provider"}'},
          finish_reason: null},
      {delta: {}, finish_reason: first ? 'tool_calls' : 'stop'},
    ].map(chunk => ({id: 'test', model: 'fixed', object: 'chat.completion.chunk', created: 1,
      choices: [{index: 0, ...chunk}]}));
    return new Response(chunks.map(chunk => 'data: ' + JSON.stringify(chunk) + '\n\n').join('') + 'data: [DONE]\n\n',
      {headers: {'content-type': 'text/event-stream'}});
  });
  await withReplay('fix', async fixture => {
    const events: unknown[] = [];
    const snapshot = await fixture.source.snapshot();
    const proposal = await withWorktree(fixture.repo, fixture.head, cwd =>
      piAgent('fixture/fixed').propose({cwd, config: fixture.config, snapshot}, async event => { events.push(event); }));
    assert.equal(calls, 2);
    assert.equal(proposal.summary, 'simulated provider');
    assert.match(JSON.stringify(events), /read_tracked_file/);
  });
});
