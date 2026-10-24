// Failover test for the Sentinel overlay: stop the primary Redis and watch the app follow the new one.
// Usage: docker compose -f compose.yaml -f compose.sentinel.yaml up -d --build && npm run test:failover
import { execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.env.SMOKE_URL ?? 'http://localhost:8080';
const LIMIT_WINDOW_MS = 10_000; // GET /limited: 3 per 10 s
let failed = false;

function check(ok, message) {
  console.log(`${ok ? '✓' : '✗'} ${message}`);
  if (!ok) failed = true;
}

const compose = (args) =>
  execSync(`docker compose -f compose.yaml -f compose.sentinel.yaml ${args}`, {
    stdio: 'pipe',
  })
    .toString()
    .trim();
const redisCli = (service, command) =>
  compose(`exec -T ${service} redis-cli ${command}`);
// Fixed IPs from compose.sentinel.yaml; Sentinel reports the primary by IP.
const SERVICE_BY_IP = {
  '172.30.0.10': 'redis',
  '172.30.0.11': 'redis-replica',
};
const primary = () =>
  SERVICE_BY_IP[
    compose(
      'exec -T --index 1 sentinel redis-cli -p 26379 SENTINEL get-master-addr-by-name mymaster',
    ).split('\n')[0]
  ];

async function waitFor(predicate, what, seconds = 60) {
  for (let i = 0; i < seconds * 5; i++) {
    try {
      if (await predicate()) return;
    } catch {
      // not ready yet
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const status = async () => (await fetch(`${BASE}/limited`)).status;

await waitFor(async () => (await fetch(`${BASE}/`)).ok, 'the stack');

const oldPrimary = primary();
const replica = oldPrimary === 'redis' ? 'redis-replica' : 'redis';
console.log(`primary: ${oldPrimary}, replica: ${replica}`);
redisCli(oldPrimary, 'FLUSHALL');

// 1. Use up the limit on the primary; replication copies the count to the replica.
const before = [];
for (let i = 0; i < 4; i++) before.push(await status());
const countedAt = Date.now();
check(
  before.join(' ') === '200 200 200 429',
  `before failover: ${before.join(' ')}`,
);
await waitFor(
  () => redisCli(replica, 'DBSIZE') === '1',
  'the count to reach the replica',
  5,
);
check(true, 'the count was replicated to the replica');

// 2. Crash the primary (SIGKILL, no clean shutdown). Sentinel needs 2 s to call it down, then
// elects and promotes the replica. The clock starts once the kill has returned: the docker CLI
// itself can take seconds and is not part of the failover.
compose(`kill ${oldPrimary}`);
const stoppedAt = Date.now();
// Recovered means the limiter answers again (200 or 429). Anything else seen on the way is
// recorded: a 502 would mean the app itself broke, not just Redis.
const during = new Set();
let after;
await waitFor(async () => {
  after = await status();
  const recovered = after === 200 || after === 429;
  if (!recovered) during.add(after);
  return recovered;
}, 'the app to recover');
const failoverMs = Date.now() - stoppedAt;

check(
  [...during].every((s) => s === 503),
  `during failover: only 503, fail-closed (saw ${[...during].join(', ') || 'no errors'})`,
);
check(primary() === replica, `Sentinel promoted ${replica} to primary`);
check(
  true,
  `app recovered ${(failoverMs / 1000).toFixed(1)} s after the primary was killed`,
);

// 3. The count survived: the client is still limited on the new primary.
if (Date.now() - countedAt < LIMIT_WINDOW_MS) {
  check(after === 429, `count survived failover: first answer is ${after}`);
} else {
  console.log(
    '- count survival not checked: failover outlasted the 10 s window',
  );
}

// 4. The old primary comes back as a replica of the new one.
compose(`start ${oldPrimary}`);
await waitFor(
  () => redisCli(oldPrimary, 'ROLE').split('\n')[0] === 'slave',
  `${oldPrimary} to rejoin as a replica`,
);
check(true, `${oldPrimary} rejoined as a replica`);

process.exit(failed ? 1 : 0);
