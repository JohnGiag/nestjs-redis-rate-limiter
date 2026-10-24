# NestJS Redis Sliding Window Rate Limiter

A distributed rate limiter for NestJS that uses Redis. It enforces an exact **sliding window** limit across any number of stateless app instances. The check-and-record step runs as one atomic Lua script inside Redis, so concurrent requests cannot race past the limit.

```ts
@Get('limited')
@RateLimit({ limit: 3, ttlSec: 10 })
getLimited() { ... }
```

## Features

- **Atomic:** the read, decide and write steps happen inside one Lua script, so there are no race conditions between instances.
- **Exact sliding window:** it uses a sliding log stored in a Redis Sorted Set, so there is no burst at the window edge (fixed windows can let through 2× the limit there).
- **Memory stays bounded:** only allowed requests are stored, so each key holds at most `limit` entries and expires on its own.
- **One clock for all instances:** timestamps come from the Redis server's clock (`TIME`), not the app's, so app servers whose clocks disagree still count the same way.
- **Survives a lost script cache:** requests use `EVALSHA` and fall back to `EVAL` when Redis replies `NOSCRIPT` (after `SCRIPT FLUSH`, a restart or a failover).
- **Security first when Redis is down:** limited routes answer `503` within milliseconds instead of letting unlimited traffic through ([details](#when-redis-is-down)).
- **Proxy-aware and spoof-resistant:** client IPs are read according to an explicit proxy hop count (`TRUST_PROXY_HOPS`).
- **Per-user or per-IP:** logged-in users are counted by user id and anonymous clients by IP, in separate key spaces.
- **Can't be half-applied:** `@RateLimit` attaches its own guard, so a limit can never be declared without being enforced.
- **Standard headers:** `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, plus `Retry-After` on `429`.

## How it works

```
Request → [AuthGuard] → RateLimiterGuard (attached by @RateLimit)
                          │ 1. Read @RateLimit metadata (Reflector). None → allow.
                          │ 2. key = rl:<METHOD>:<route pattern>:user:<id> | ip:<ip>
                          │    e.g. rl:POST:/auth/login:ip:203.0.113.7
                          │ 3. EVALSHA sliding-window.lua  (EVAL on NOSCRIPT)
                          │    Redis error → 503 (default) | allow if failOpen: true
                          │ 4. Set X-RateLimit-* headers
                          └ 5. allowed → handler   |   denied → 429 + Retry-After
```

For each request, the Lua script ([`sliding-window.lua`](src/rate-limiter/lua/sliding-window.lua)) runs these steps in order:

1. Reads the current time from Redis with `TIME`.
2. Removes timestamps older than the window with `ZREMRANGEBYSCORE`.
3. Counts the requests left in the window with `ZCARD`.
4. If the count is below the limit, records this request with `ZADD`; its score is the timestamp and its member is a UUID.
5. Refreshes the key's expiry with `PEXPIRE`.
6. Returns `[allowed, remaining, resetSeconds]`. `resetSeconds` is computed from the oldest entry still in the window.

Redis runs scripts one at a time and never interleaves other commands with them. Two requests that arrive in the same millisecond are therefore serialized, and the second one sees the first one's write.

## Quick start

### Option A: Docker (nothing to install but Docker)

Runs the production setup on one machine: nginx as the load balancer, 3 app replicas and Redis.

```bash
docker compose up -d --build
for i in 1 2 3 4; do curl -s -o /dev/null -w "%{http_code}\n" localhost:8080/limited; done
# 200 200 200 429

npm run test:docker      # smoke test against the running stack (see Testing)
docker compose down
```

### Option B: Local development

**Requirements:** Node.js 24+ and Redis 6.2+ (Redis must be reachable from the host).

```bash
# 1. Start Redis
docker run -d --name redis -p 6379:6379 redis:7-alpine

# 2. Install and configure
npm install
cp .env.example .env

# 3. Run
npm run start:dev
```

Try it:

```bash
for i in 1 2 3 4; do curl -s -o /dev/null -w "%{http_code}\n" localhost:3000/limited; done
# 200 200 200 429
```

## Configuration

| Variable           | Required | Default | Description |
|--------------------|----------|---------|-------------|
| `REDIS_URL`        | yes, unless Sentinel | none | `redis://[:password@]host:port[/db]`. The app refuses to start without it. |
| `REDIS_SENTINELS`  | no       | none    | `host:port[,host:port…]`. When set, the app connects through Redis Sentinel and follows the primary across failovers. `REDIS_URL` is then ignored. |
| `REDIS_SENTINEL_NAME` | with Sentinel | none | The primary's name in Sentinel, for example `mymaster`. |
| `REDIS_PASSWORD`   | no (Sentinel only) | none | Password for Redis and the Sentinels in Sentinel mode. In single-Redis mode, put the password in `REDIS_URL` instead. |
| `TRUST_PROXY_HOPS` | no       | `0`     | How many proxies or load balancers sit in front of the app. See [Running behind a proxy](#running-behind-a-proxy). |
| `PORT`             | no       | `3000`  | HTTP port. |
| `EXPOSE_UPSTREAM`  | no (Docker only) | `0` | `1` makes nginx add an `X-Upstream` header naming the replica that answered. Used by the Docker smoke test; keep it `0` in production because it reveals internal addresses. |

Values come from the process environment first, then from `.env`, through `@nestjs/config`. `docker compose` also reads `.env` to fill in `${…}` values in `compose.yaml`.

## Usage

1. Import `RateLimiterModule` into the module that owns the controller. The guard depends on `RateLimiterService`.
2. Add `@RateLimit()` to a route or a whole controller. It attaches `RateLimiterGuard` itself:

```ts
import { RateLimit } from './rate-limiter/decorators/rate-limit.decorator';

@Controller('auth')
@RateLimit({ limit: 100, ttlSec: 60 })   // default for every route in the controller
export class AuthController {
  @Post('login')
  @RateLimit({ limit: 5, ttlSec: 60 })   // a method-level limit overrides the class one
  login() { ... }
}
```

- **One bucket per route and client.** Using up `/login` does not affect `/search`. Keys use the route pattern (`/users/:id`), so every id shares one bucket, and two controllers with the same class name never collide. `HEAD` counts against the `GET` bucket, because Express answers `HEAD` with the `GET` handler; a separate bucket would double every `GET` limit. Other methods (`POST`, `PUT`, …) keep their own buckets.
- **Counted once.** With `@RateLimit` on both the class and a method, the guard is attached twice but counts each request only once, using the method's limit.
- **Checked at startup.** Invalid options (`limit` below 1 or not a whole number, `ttlSec` below 1 ms, `NaN`, `Infinity`) throw an error when the class loads, so the app fails at startup instead of silently running without a limit.

### With authentication: guard order matters

The rate limiter must run **after** authentication, so that `req.user` is set and users are counted by id. NestJS runs guards in this order: **global → controller → method**.

```ts
// ✅ Recommended: auth on the controller (or global). It always runs before @RateLimit on a method.
@Controller('orders')
@UseGuards(AuthGuard('jwt'))
export class OrdersController {
  @Post()
  @RateLimit({ limit: 10, ttlSec: 60 })   // counted per user: rl:POST:/orders:user:42
  create() { ... }
}

// ✅ Auth and limit on the same method: write @RateLimit ABOVE @UseGuards (decorators apply bottom-up).
@Post()
@RateLimit({ limit: 10, ttlSec: 60 })
@UseGuards(AuthGuard('jwt'))
create() { ... }

// ❌ Reversed on the same method: the limiter runs first, so users are counted per IP.
@Post()
@UseGuards(AuthGuard('jwt'))
@RateLimit({ limit: 10, ttlSec: 60 })
create() { ... }
```

The guard is not a global `APP_GUARD` on purpose: global guards run before every controller-level guard, so they could never see the user.

### Response headers

| Header                  | Example | Meaning                                       |
|-------------------------|---------|-----------------------------------------------|
| `X-RateLimit-Limit`     | `5`     | Requests allowed per window                   |
| `X-RateLimit-Remaining` | `0`     | Requests left in the current window           |
| `X-RateLimit-Reset`     | `42`    | Seconds until a slot frees up (a duration, not an epoch timestamp) |
| `Retry-After`           | `42`    | Sent only with `429 Too Many Requests`        |

## Running behind a proxy

Anonymous clients are identified by `req.ip`. How Express computes it depends on `TRUST_PROXY_HOPS`:

| `TRUST_PROXY_HOPS` | `req.ip` is | Use when |
|---|---|---|
| `0` (default) | the TCP peer address | Clients connect directly to the app |
| `N` | the address `N` hops from the right of `X-Forwarded-For` | Exactly `N` proxies you control sit in front of the app (for example, `1` for a single load balancer) |

Set it to the real number of proxies:
- **Too low:** every client appears to come from the proxy's IP and all of them share one limit.
- **Too high:** clients can put any IP in `X-Forwarded-For` and get a fresh limit with every request.

The app never uses `trust proxy = true`, because that trusts the leftmost entry, which the client fully controls.

## When Redis is down

Each route chooses what happens when the limiter can't reach Redis. The default is **fail-closed (security first)**.

```ts
@Post('login')
@RateLimit({ limit: 5, ttlSec: 60 })                    // fail-closed (default): 503 during an outage

@Get('products')
@RateLimit({ limit: 100, ttlSec: 60, failOpen: true })  // fail-open: served unmetered during an outage
```

| | Fail-closed (default) | Fail-open (`failOpen: true`) |
|---|---|---|
| During an outage | `503 Service Unavailable` | Request goes through, **not counted** |
| Rate-limit headers | none | none (nothing could be counted) |
| Priority | Security | Availability |
| Use for | login, OTP, password reset, payments, anything open to brute force | public reads, search, catalogue pages |

In both cases:
- The failure is logged as one line that names the key and the policy, for example `… rl:GET:/products:ip:… failing open: Connection is closed.` There's no stack trace, so an outage doesn't flood the logs. Alert on these lines: on fail-open routes, nothing limits traffic while they appear.
- Routes without `@RateLimit` are not affected.
- The decision comes fast in every kind of outage. Each Redis client setting below was measured on the Docker stack, and settings that made no measurable difference were removed:

| Setting | Outage | Without it | With it |
|---|---|---|---|
| `maxRetriesPerRequest: 1` | Redis stopped (connection closed) | request waits ~70 s of reconnect attempts | `503` in milliseconds |
| `commandTimeout: 500` | Redis frozen or network partition (connection open, no answer) | request hangs (nginx gives up after 60 s) | `503` in ~505 ms |
| `connectTimeout: 1000` | Sentinel failover (old primary's address is dead) | app back after 9.7 s | app back after 2–3.5 s |

Only the literal `true` opens the gate. A missing option, `false` or any other value stays closed, so a mistake errs on the safe side.

## Testing

```bash
npm test               # unit tests (no Redis needed)
npm run test:e2e       # integration and e2e tests (need a local Redis at REDIS_URL)
npm run test:docker    # smoke test against the running Docker stack
npm run test:load      # k6 load test against the running Docker stack (3 min at 500 req/s)
npm run test:failover  # Redis failover test against the Sentinel stack
```

| Layer | What it proves | Needs |
|---|---|---|
| Unit | Guard, decorator, config parsing logic | nothing |
| Integration and e2e | Lua script semantics, HTTP behaviour, 3 instances behind an emulated load balancer | local Redis |
| Docker smoke | The same against real nginx, containers, a frozen Redis and a Redis restart | `docker compose up` |
| Load | No errors, low latency and an exact limit under sustained load; no memory growth | `docker compose up` |
| Failover | The app follows Sentinel to a new primary; counts survive | Sentinel overlay |

All of it runs in [CI](#continuous-integration) on every push.

The e2e suites run `SCRIPT FLUSH` (which affects the whole Redis server) and delete `rl:*` keys, so they **refuse to run** unless `REDIS_URL` points at `localhost`, `127.0.0.1` or `[::1]`. They run one at a time (`--runInBand`) so they don't wipe each other's keys.

### Multiple instances behind a load balancer

[`test/multi-instance.e2e-spec.ts`](test/multi-instance.e2e-spec.ts) emulates a production deployment inside the test process, with no Docker or nginx needed:

```
             ┌──────────────────────────────┐
 client ───► │ round-robin load balancer    │  appends X-Forwarded-For, like nginx
 127.0.0.1   │ (node:http, ~30 lines)       │
 127.0.0.2   └──────┬──────────┬──────────┬─┘
                    ▼          ▼          ▼
               instance 0  instance 1  instance 2   separate Nest apps, separate
               (hops = 1)  (hops = 1)  (hops = 1)   Redis connections and script loads
                    └──────────┼──────────┘
                               ▼
                             Redis
```

| Scenario | Verifies |
|---|---|
| 4 sequential requests, served by instances 0 → 1 → 2 → 0 | `200 200 200 429`: instance 0 refuses after seeing only one earlier request, so the count is shared through Redis |
| 60 concurrent requests across all 3 instances | Exactly 3 × `200`, so there's no race between instances |
| Two clients (`127.0.0.1`, `127.0.0.2`) through the same balancer | Each gets its own 3 requests: clients are identified by the forwarded IP, not the balancer's |
| Client sends its own `X-Forwarded-For` | Ignored: with `TRUST_PROXY_HOPS=1`, only the balancer's entry is trusted |

| Suite | Scenario | Verifies |
|---|---|---|
| unit, decorator | `@RateLimit` on a method | Attaches `RateLimiterGuard` |
| unit, decorator | Invalid `limit` / `ttlSec` | Fails at startup, not silently |
| unit, trust proxy | `"0"`, `"1"`, `"abc"`, `"-1"`, `""` … | Passed to Express as a number; invalid values stop startup |
| unit, guard | Route without `@RateLimit` | Skipped, Redis not called |
| unit, guard | Method, route pattern, user id vs IP | Keys like `rl:POST:/users/:id:ip:…`; `user:` / `ip:` kept apart, including user id `0` |
| unit, guard | `HEAD`; `POST` / `PUT` / `PATCH` / `DELETE` | `HEAD` uses the `GET` key; the others keep their own |
| unit, guard | Guard runs twice on one request | Counted once |
| unit, guard | Limit reached | `429` with `Retry-After` |
| unit, guard | Redis error | `503` (fail closed), one log line without a stack trace |
| unit, guard | Redis error on a `failOpen: true` route | Allowed, no rate-limit headers |
| integration, service | Requests 1–4 with limit 3 | `remaining` counts down; `resetSec` is within the window |
| integration, service | Requests spaced in time | The window **slides**: only the oldest slot frees up |
| integration, service | 10 calls with limit 2 | Denied requests are not stored (memory stays bounded) |
| integration, service | Limit lowered from 5 to 3 | `remaining` is `0`, never negative |
| integration, service | After a call | The key has an expiry |
| e2e | 50 concurrent requests | Exactly 3 × `200` and 47 × `429` (atomicity) |
| e2e | 3 × `GET` then `HEAD`, and 3 × `HEAD` then `GET` | `429` both ways: one shared quota, so `HEAD` can't be used to double the limit |
| e2e | `@RateLimit` on class and method | The method limit applies, each request counted once |
| e2e | `SCRIPT FLUSH`, then a request | The `EVALSHA` → `EVAL` fallback |
| e2e | Rotating `X-Forwarded-For` | A fake header cannot get around the limit |
| e2e | Redis disconnected | `503` on default routes, `200` (unmetered, past the limit) on `failOpen` routes, `200` on unlimited routes, recovery afterwards |

### Docker stack smoke test

`npm run test:docker` ([`test/docker-smoke.mjs`](test/docker-smoke.mjs)) runs against the `docker compose` stack, so everything is real: nginx, separate containers, the Docker network and a Redis restart. It clears the stack's own Redis first (that Redis isn't published to the host), so it can be run again at any time.

```
✓ 30 concurrent requests: exactly 3 allowed (got 3)
✓ the other 27 refused with 429
✓ served by 3 replicas: 172.18.0.4:3000, 172.18.0.3:3000, 172.18.0.5:3000
✓ 429 carries Retry-After (10s)
✓ spoofed X-Forwarded-For is ignored (still 429)
✓ Redis frozen: /limited answers 503 in 505 ms (got 503)
✓ recovered after Redis unfroze
✓ Redis down: /limited answers 503 (got 503)
✓ Redis down: / still answers 200
✓ recovered after Redis restart (script cache rebuilt via EVAL fallback)
```

- **Frozen Redis** (`docker compose pause redis`): the process stops answering but the connection stays open. That's what an overloaded Redis or a network partition between machines looks like, and it's the case that used to hang requests.
- **Stopped Redis** (`docker compose stop redis`): the restarted Redis has an empty script cache, so recovery also proves the `NOSCRIPT` → `EVAL` fallback under real conditions.
- The replica-spread check needs `EXPOSE_UPSTREAM=1` (set in `.env.example`); without it, the check is skipped.

### Load test

`npm run test:load` runs [k6](https://k6.io) in a container ([`test/load/sliding-window.js`](test/load/sliding-window.js)) against nginx. It holds a constant rate (`RATE`, default 500 req/s) for `DURATION_S` (default 180 s), and fails if any threshold is missed:

| Threshold | Result (3 min, 500 req/s, 90,001 requests) |
|---|---|
| No errors: only `200` or `429`, no `5xx`, no timeouts | 0 errors |
| Latency p95 < 50 ms, p99 < 200 ms | p95 **1.31 ms**, p99 1.72 ms |
| The system keeps up with the requested rate | 0 dropped |
| The limit stays exact: 3 per 10 s → 51–57 allowed in 180 s | **57** allowed |

App memory went from 63–68 MB to 44–49 MB per replica during the run, and Redis stayed at 1.24 MB with a single key, so nothing grows over time.

### Redis failover

[`compose.sentinel.yaml`](compose.sentinel.yaml) is an overlay that replaces the single Redis with a primary, a replica and 3 Sentinels (quorum 2), and points the app at Sentinel:

```bash
docker compose -f compose.yaml -f compose.sentinel.yaml up -d --build --wait
npm run test:failover
```

[`test/failover-smoke.mjs`](test/failover-smoke.mjs) uses up a client's limit, kills the primary with `SIGKILL` and watches the app:

```
✓ before failover: 200 200 200 429
✓ the count was replicated to the replica
✓ during failover: only 503 (fail-closed), never a 200
✓ Sentinel promoted redis-replica to primary
✓ app recovered 2.1 s after the primary was killed
✓ count survived failover: first answer is 429
✓ redis rejoined as a replica
```

- Recovery takes 2–3.5 s. Most of it is Sentinel's `down-after-milliseconds` (2 s) before it declares the primary dead.
- The test can be rerun as often as you like: roles swap each time.
- A **planned** failover (`SENTINEL FAILOVER mymaster`) was also checked by hand. No request failed, because Sentinel disconnects the old primary's clients and ioredis reconnects through Sentinel.
- **Limit of async replication:** a count written to the primary in the last moment before a crash may not reach the replica. A client could then get one or two extra requests right after a failover. For a rate limiter this is an accepted trade-off.
- **Everything is password-protected,** like a real Sentinel setup: Redis (`requirepass`, plus `masterauth` because roles swap), the Sentinels (`requirepass`, `sentinel-pass`, `auth-pass`), and the app through `REDIS_PASSWORD`. The default password is for this local stack only; set `REDIS_PASSWORD` in the environment to override it. Without it, the app fails at startup with `NOAUTH`.
- **The "only 503" check can fail:** the test waits for a real answer (`200` or `429`) and records every other status it sees on the way. A `502` from a crashed app would show up there and fail the test, not count as recovery.
- The Redis containers get fixed IPs in the overlay. Docker removes a stopped container's name from DNS, and Sentinel stalls on the failed lookups ("TILT mode") and never fails over. Real servers keep their address when Redis crashes.

## Continuous integration

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push to `main` and every pull request:

1. **test:** `npm ci`, lint, `npm audit --omit=dev --audit-level=high`, build, unit and e2e tests, against a Redis service container.
2. **docker:** builds the stack, then runs the smoke test, a 30-second load test and the Sentinel failover test.

`package.json` uses an npm `overrides` entry to pin `multer` (used inside `@nestjs/platform-express`) to `^2.5.0`, which fixes a denial-of-service advisory in 2.4.0. This app has no upload routes, but the audit gate stays clean.

## Docker

| File | What it does |
|---|---|
| [`Dockerfile`](Dockerfile) | Multi-stage build: compiles in a full image, then ships only `dist/` and production dependencies. Runs as the non-root `node` user. Its health check calls `GET /`, which doesn't use Redis, so a Redis outage doesn't get the app containers restarted. |
| [`compose.yaml`](compose.yaml) | Redis (internal only) → 3 app replicas (`TRUST_PROXY_HOPS=1`) → nginx on port `8080`. Startup order follows health checks. Every service has `restart: unless-stopped`. k6 is under the `load` profile and only starts for `npm run test:load`. |
| [`docker/nginx/default.conf.template`](docker/nginx/default.conf.template) | Round-robin over the replicas with keep-alive connections, appends `X-Forwarded-For`, and adds `X-Upstream` when `EXPOSE_UPSTREAM=1`. The nginx image fills in environment variables when it starts. |
| [`compose.sentinel.yaml`](compose.sentinel.yaml) | Failover overlay (see [Redis failover](#redis-failover)). |

- **Graceful shutdown is verified:** on `docker compose stop`, the containers exit with code `0` within a few seconds, not `137` (killed after the 10 s timeout).
- **Self-healing is verified:** a killed app container came back healthy within 13 s. After a Docker restart, an app that starts before Redis is ready exits and is retried until Redis is up.
- **Keep-alive is verified:** after 200 requests, nginx held 12 reused connections to the replicas and had 0 closed connections waiting to be cleaned up (`TIME_WAIT`).
- **Keep-alive timeouts are ordered:** nginx drops idle connections after 4 s, before Node's 5 s `keepAliveTimeout`. The other way round, nginx can send a request on a connection Node is closing at that moment, which gives a `502` that nginx doesn't retry for `POST`. Verified: 4.6 s after a burst, nginx holds 0 open connections to the app.
- **Limitation:** nginx resolves `app` to the replica IPs once, at startup. After scaling or recreating replicas, restart nginx too (`docker compose restart nginx`).

## Project structure

```
src/
├── main.ts                           # bootstrap, shutdown hooks
├── trust-proxy.ts                    # TRUST_PROXY_HOPS → Express "trust proxy"
├── app.module.ts                     # ConfigModule, RedisModule, RateLimiterModule
├── app.controller.ts                 # demo routes: GET / and GET /limited
├── redis/
│   ├── redis.module.ts               # global ioredis client (single or Sentinel), timeouts, closes on shutdown
│   └── sentinels.ts                  # REDIS_SENTINELS parsing
└── rate-limiter/
    ├── rate-limiter.module.ts        # exports RateLimiterService and RateLimiterGuard
    ├── decorators/rate-limit.decorator.ts  # options validation, attaches the guard
    ├── guards/rate-limiter.guard.ts        # options type, key building, headers, 429/503
    ├── services/rate-limiter.service.ts    # SCRIPT LOAD, EVALSHA, EVAL fallback
    └── lua/sliding-window.lua
test/
├── app.e2e-spec.ts                   # HTTP behaviour through the full app
├── rate-limiter.service.e2e-spec.ts  # sliding window semantics against real Redis
├── multi-instance.e2e-spec.ts        # 3 instances behind an emulated load balancer
├── docker-smoke.mjs                  # smoke test against the running compose stack
├── failover-smoke.mjs                # Sentinel failover test
├── load/sliding-window.js            # k6 load test
└── local-redis.ts                    # refuses to run the suites against a non-local Redis
docker/nginx/default.conf.template    # load balancer config
Dockerfile, compose.yaml, compose.sentinel.yaml, .dockerignore
.github/workflows/ci.yml
```

**Graceful shutdown:** `main.ts` calls `app.enableShutdownHooks()`, so on `SIGTERM` (Docker, Kubernetes) NestJS runs its shutdown hooks and the Redis connection is closed cleanly.

`nest-cli.json` copies `*.lua` into `dist/` during the build.

## Design decisions

| Decision | Why |
|---|---|
| Lua script, not `MULTI`/`EXEC` | A transaction cannot branch on a value it reads; `WATCH` would need retries when contention is high. |
| Sliding log (ZSET), not `INCR` + TTL | Fixed windows let through up to 2× the limit at the window edge. |
| Redis `TIME`, not `Date.now()` | Clock skew between app instances would corrupt the window. |
| UUID member | ZSET members are unique; two requests in the same millisecond would otherwise collapse into one entry. |
| Retry only on `NOSCRIPT` | `NOSCRIPT` guarantees the script did not run. After a timeout we can't know whether it ran, so a retry could count the request twice. |
| Guard attached by `@RateLimit`, not `APP_GUARD` | It must run after authentication to see `req.user`, and a limit can't be declared without being enforced. |
| Key from HTTP method + route pattern | Class names can repeat across modules; the route pattern is unique per endpoint. |
| `HEAD` counted as `GET` | Express runs the `GET` handler for `HEAD`. A separate bucket gave every `GET` route twice its limit, which was confirmed and is now covered by tests. |
| `math.max(limit - count, 0)` | After a limit is lowered, a window can hold more entries than the new limit. |
| Fail closed by default, `failOpen` per route | An outage must not silently disable protection; routes that value availability opt out explicitly. |
| `maxRetriesPerRequest`, `commandTimeout`, `connectTimeout` | Every kind of Redis outage (stopped, frozen, failing over) must give a fast answer, never a hanging request. Each one was measured. |
| Sentinel support built into ioredis | Following a new primary after failover is ioredis's job; the app only parses the list of Sentinel addresses. |
| No default for `REDIS_URL` | Fail fast. A missing variable should stop startup, not quietly connect to `localhost`. |

## Tech stack

NestJS · TypeScript (strict) · ioredis · Redis (+ Sentinel) · @nestjs/config · Jest · Supertest · Docker · nginx · k6 · GitHub Actions

## License

[MIT](LICENSE) © 2026 Giannis Giagkoudis
