// Smoke test for the running compose stack: nginx :8080 → 3 app replicas → Redis.
// Usage: docker compose up -d --build && npm run test:docker
import { execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.env.SMOKE_URL ?? 'http://localhost:8080';
let failed = false;

function check(ok, message) {
  console.log(`${ok ? '✓' : '✗'} ${message}`);
  if (!ok) failed = true;
}

async function waitFor(predicate, what, seconds = 60) {
  for (let i = 0; i < seconds; i++) {
    try {
      if (await predicate()) return;
    } catch {
      // not up yet
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const compose = (args) => execSync(`docker compose ${args}`, { stdio: 'pipe' });

// Recovered means the limiter answers again; a 502 (app down) must not count as recovery.
const limiterAnswers = async () =>
  [200, 429].includes((await fetch(`${BASE}/limited`)).status);

await waitFor(async () => (await fetch(`${BASE}/`)).ok, 'the stack');
// Fresh counters. This Redis belongs to the compose stack only and is not published.
compose('exec -T redis redis-cli FLUSHALL');

// 1. Burst through nginx: shared count across replicas, no race.
const burst = await Promise.all(
  Array.from({ length: 30 }, () => fetch(`${BASE}/limited`)),
);
const statuses = burst.map((r) => r.status);
const upstreams = new Set(
  burst.map((r) => r.headers.get('x-upstream')).filter(Boolean),
);
check(
  statuses.filter((s) => s === 200).length === 3,
  `30 concurrent requests: exactly 3 allowed (got ${statuses.filter((s) => s === 200).length})`,
);
check(
  statuses.filter((s) => s === 429).length === 27,
  'the other 27 refused with 429',
);
if (upstreams.size === 0) {
  console.log(
    '- replica spread not checked: start the stack with EXPOSE_UPSTREAM=1',
  );
} else {
  check(
    upstreams.size > 1,
    `served by ${upstreams.size} replicas: ${[...upstreams].join(', ')}`,
  );
}

// 2. Headers on a refused request.
const refused = await fetch(`${BASE}/limited`);
check(
  refused.status === 429 && Number(refused.headers.get('retry-after')) > 0,
  `429 carries Retry-After (${refused.headers.get('retry-after')}s)`,
);

// 3. A made-up X-Forwarded-For does not buy a fresh limit.
const spoofed = await fetch(`${BASE}/limited`, {
  headers: { 'X-Forwarded-For': '203.0.113.99' },
});
check(spoofed.status === 429, 'spoofed X-Forwarded-For is ignored (still 429)');

// 4. Frozen Redis (overloaded, or a network partition): the socket stays open but nothing answers.
// The command timeout must turn that into a fast 503 instead of a hanging request.
compose('pause redis');
try {
  const started = Date.now();
  const frozen = await fetch(`${BASE}/limited`, {
    signal: AbortSignal.timeout(10_000),
  });
  const ms = Date.now() - started;
  check(
    frozen.status === 503 && ms < 2000,
    `Redis frozen: /limited answers 503 in ${ms} ms (got ${frozen.status})`,
  );
} finally {
  compose('unpause redis');
}
await waitFor(limiterAnswers, 'recovery after Redis unfreezes');
check(true, 'recovered after Redis unfroze');

// 5. Redis outage: fail closed on limited routes, the rest keeps working.
compose('stop redis');
try {
  const limited = await fetch(`${BASE}/limited`);
  const root = await fetch(`${BASE}/`);
  check(
    limited.status === 503,
    `Redis down: /limited answers 503 (got ${limited.status})`,
  );
  check(root.status === 200, 'Redis down: / still answers 200');
} finally {
  compose('start redis');
}

// 6. Recovery. Redis restarted with an empty script cache, so this also exercises the EVAL fallback.
await waitFor(limiterAnswers, 'recovery after Redis restart');
check(
  true,
  'recovered after Redis restart (script cache rebuilt via EVAL fallback)',
);

process.exit(failed ? 1 : 0);
