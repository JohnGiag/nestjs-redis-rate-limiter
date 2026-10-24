// k6 soak test: sustained load through nginx → 3 replicas → Redis.
// Run: npm run test:load   (env: RATE requests/s, default 500; DURATION_S, default 180)
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://nginx';
const RATE = Number(__ENV.RATE || 500);
const DURATION_S = Number(__ENV.DURATION_S || 180);

// GET /limited allows 3 per 10 s. Under constant load a slot reopens exactly when its entry
// leaves the window, so about 3 per 10 s get through. One window of slack on each side covers
// the start (counts left from earlier runs) and the end of the test.
const LIMIT = 3;
const WINDOW_S = 10;
const windows = Math.floor(DURATION_S / WINDOW_S);
const minAllowed = LIMIT * (windows - 1);
const maxAllowed = LIMIT * (windows + 1);

const allowed = new Counter('allowed_requests');

// 429 is a correct answer here, not a failure.
http.setResponseCallback(http.expectedStatuses(200, 429));

export const options = {
  scenarios: {
    sustained: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: `${DURATION_S}s`,
      preAllocatedVUs: 50,
      maxVUs: 300,
    },
  },
  thresholds: {
    http_req_failed: ['rate==0'], // no 5xx, no timeouts, no connection errors
    checks: ['rate==1'],
    http_req_duration: ['p(95)<50', 'p(99)<200'], // milliseconds
    dropped_iterations: ['count==0'], // the system kept up with the requested rate
    allowed_requests: [`count>=${minAllowed}`, `count<=${maxAllowed}`], // limiter stays exact
  },
};

export default function () {
  const res = http.get(`${BASE}/limited`);
  if (res.status === 200) allowed.add(1);
  check(res, {
    'status is 200 or 429': (r) => r.status === 200 || r.status === 429,
  });
}
