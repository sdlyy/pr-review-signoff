const test = require('node:test');
const assert = require('node:assert/strict');
const { summarize } = require('../pr-review-signoff.user.js');

const fixture = (n) => structuredClone(require(`./fixtures/l2beat-l2beat-${n}.json`));
// [name, verdict, note, reviewed commit: 'HEAD' | short sha | null]
const rows = (s) => s.rows.map((r) => [r.name, r.verdict, r.note, r.sha ? (r.sha === s.head ? 'HEAD' : r.sha.slice(0, 7)) : null]);

const cases = {
  13935: { ok: '3/3', absent: [], rows: [
    ['Codex', 'ok', 'no findings', 'HEAD'],
    ['CodeRabbit', 'ok', 'Minimal risk', 'HEAD'],
    ['Greptile', 'ok', 'confidence 5/5', 'HEAD'],
  ] },
  13886: { ok: '2/2', absent: ['Greptile'], rows: [
    ['Codex', 'ok', 'no findings', 'HEAD'],
    ['CodeRabbit', 'ok', 'Minimal risk', 'HEAD'],
  ] },
  13915: { ok: '1/3', absent: [], rows: [
    ['Codex', 'ok', 'no findings', 'HEAD'],
    ['CodeRabbit', 'skipped', 'review limit reached', '45c7fda'],
    ['Greptile', 'stale', 'confidence 4/5', '45c7fda'],
  ] },
  13931: { ok: '1/3', absent: [], rows: [
    ['Codex', 'ok', 'no findings', 'HEAD'],
    ['CodeRabbit', 'skipped', 'review limit reached', null],
    ['Greptile', 'stale', 'confidence 5/5', 'c9754cf'],
  ] },
  13914: { ok: '0/3', absent: [], rows: [
    ['Codex', 'findings', '1 open thread', 'HEAD'],
    ['CodeRabbit', 'findings', '1 open thread', 'HEAD'],
    ['Greptile', 'stale', 'confidence 4/5', '0188b73'],
  ] },
  13922: { ok: '0/3', absent: [], rows: [
    ['Codex', 'stale', 'no findings', 'df6dcb4'],
    ['CodeRabbit', 'findings', '21 open threads', null],
    ['Greptile', 'findings', '3 open threads', 'df6dcb4'],
    ['github-advanced-security', 'findings', '1 open thread', 'HEAD'],
  ] },
};

for (const [n, want] of Object.entries(cases)) {
  test(`l2beat/l2beat#${n}`, () => {
    const s = summarize(fixture(n));
    assert.equal(`${s.okCount}/${s.total}`, want.ok);
    assert.deepEqual(s.absent, want.absent);
    assert.deepEqual(rows(s), want.rows);
  });
}

test('a bot whose marker format changed shows as unknown, never signed off', () => {
  const pr = fixture(13935);
  for (const c of [...pr.early.nodes, ...pr.recent.nodes]) c.body = c.body.replace(/codex-review-state:v1/g, 'codex-review-state:v2');
  const codex = summarize(pr).rows.find((r) => r.name === 'Codex');
  assert.equal(codex.verdict, 'unknown');
});

test('a running check on HEAD wins over an older sign-off', () => {
  const pr = fixture(13935);
  pr.commits.nodes[0].commit.statusCheckRollup.contexts.nodes.push({ __typename: 'CheckRun', name: 'Greptile Review', status: 'IN_PROGRESS' });
  const greptile = summarize(pr).rows.find((r) => r.name === 'Greptile');
  assert.equal(greptile.verdict, 'running');
});

test('a PR without review agents lists all of them as not run', () => {
  const pr = fixture(13935);
  pr.early.nodes = [];
  pr.recent.nodes = [];
  pr.reviews.nodes = [];
  pr.reviewThreads.nodes = [];
  const s = summarize(pr);
  assert.deepEqual(s.rows, []);
  assert.deepEqual(s.absent, ['Codex', 'CodeRabbit', 'Greptile']);
});
