import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = await readFile(new URL('../.github/workflows/collaborator-reviews.yml', import.meta.url), 'utf8');
const script = workflow.split(/          script: \|\r?\n/)[1];
assert.ok(script, 'Run the script from the real workflow');
const runScript = new Function('github', 'context', `return (async () => {\n${script}\n})();`);
const repo = { owner: 'fixture-owner', repo: 'fixture-repo' };
const pull = { ...repo, pull_number: 42 };
const collaborators = ['owner', 'alice', 'bob'].map(login => ({ login, permissions: { push: true } }));

for (const { author, pending, expected } of [
  { author: 'owner', pending: [], expected: ['alice', 'bob'] },
  { author: 'alice', pending: [], expected: ['owner', 'bob'] },
  { author: 'bob', pending: [], expected: ['owner', 'alice'] },
  { author: 'outside-contributor', pending: [], expected: ['owner', 'alice', 'bob'] },
  { author: 'ALICE', pending: ['OWNER'], expected: ['bob'] },
  { author: 'alice', pending: ['owner', 'bob'], expected: [] },
]) {
  test(`review requests: ${author}, already pending: ${pending.join(', ') || 'none'}`, async () => {
    const calls: unknown[] = [];
    const listCollaborators = () => assert.fail('Collaborators must be paginated');
    const github = {
      paginate: async (endpoint: unknown, params: unknown) => {
        assert.equal(endpoint, listCollaborators);
        assert.deepEqual(params, { ...repo, affiliation: 'all', per_page: 100 });
        return [...collaborators, { login: 'read-only', permissions: { push: false } }];
      },
      rest: {
        repos: { listCollaborators },
        pulls: {
          listRequestedReviewers: async (params: unknown) => {
            assert.deepEqual(params, pull);
            return { data: { users: pending.map(login => ({ login })) } };
          },
          requestReviewers: async (params: unknown) => { calls.push(params); },
        },
      },
    };
    await runScript(github, { repo, payload: { pull_request: { number: 42, user: { login: author } } } });
    assert.deepEqual(calls, expected.length ? [{ ...pull, reviewers: expected }] : []);
  });
}

test('collaborator lookup failures fail the workflow instead of silently skipping review requests', async () => {
  const failure = new Error('GitHub denied collaborator access');
  await assert.rejects(runScript({
    paginate: async () => { throw failure; },
    rest: { repos: { listCollaborators() {} } },
  }, { repo, payload: { pull_request: { number: 42, user: { login: 'alice' } } } }), failure);
});
