// Records a PR's GraphQL response as a test fixture.
// Usage: GH_TOKEN=$(gh auth token) node scripts/record-fixture.js owner/repo 123 [456 ...]
//
// Keeps only bot-authored data and, in comment bodies, only the lines the parsers read,
// then checks that the trimmed fixture still summarizes exactly like the live PR.
const fs = require('node:fs');
const path = require('node:path');
const { QUERY, summarize } = require('../pr-review-signoff.user.js');

const KEEP_LINE = /codex-review-state|final_review_risk|Merge Risk|Review limit reached|Review skipped|greptile_summary|greptile_confidence_score|Last reviewed commit/;
const isBot = (author) => author?.__typename === 'Bot';

function trim(pr) {
  const comments = (list) => list.nodes.filter((c) => isBot(c.author))
    .map((c) => ({ ...c, body: c.body.split('\n').filter((l) => KEEP_LINE.test(l)).join('\n') }));
  return {
    ...pr,
    early: { nodes: comments(pr.early) },
    recent: { nodes: comments(pr.recent) },
    reviews: { nodes: pr.reviews.nodes.filter((r) => isBot(r.author)) },
    reviewThreads: { nodes: pr.reviewThreads.nodes.filter((t) => isBot(t.comments.nodes[0]?.author)) },
  };
}

async function main() {
  const [repo, ...numbers] = process.argv.slice(2);
  const [owner, name] = (repo ?? '').split('/');
  if (!process.env.GH_TOKEN || !owner || !name || !numbers.length) {
    console.error('Usage: GH_TOKEN=... node scripts/record-fixture.js owner/repo 123 [456 ...]');
    process.exit(1);
  }
  for (const number of numbers.map(Number)) {
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: { Authorization: `bearer ${process.env.GH_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: QUERY, variables: { owner, name, number } }),
    });
    const json = await res.json();
    if (json.errors) throw new Error(`${repo}#${number}: ${json.errors[0].message}`);
    const pr = json.data.repository.pullRequest;
    const fixture = trim(pr);
    if (JSON.stringify(summarize(fixture)) !== JSON.stringify(summarize(pr))) {
      throw new Error(`${repo}#${number}: trimming changed the summary, widen KEEP_LINE`);
    }
    const file = path.join(__dirname, '..', 'test', 'fixtures', `${owner}-${name}-${number}.json`);
    fs.writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`wrote ${path.relative(process.cwd(), file)}`);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
