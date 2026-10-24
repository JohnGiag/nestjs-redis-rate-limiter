import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Redis } from 'ioredis';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { AppModule } from './../src/app.module';
import { REDIS_CLIENT } from './../src/redis/redis.module';
import { applyTrustProxy } from './../src/trust-proxy';
import { assertLocalRedis } from './local-redis';

const INSTANCES = 3;

// Round-robin reverse proxy, like nginx: appends the caller's address to X-Forwarded-For
// and tags each response with the instance that served it.
async function startLoadBalancer(ports: number[]): Promise<http.Server> {
  let next = 0;
  const server = http.createServer((req, res) => {
    const target = next++ % ports.length;
    const forwardedFor = [
      req.headers['x-forwarded-for'],
      req.socket.remoteAddress,
    ]
      .filter(Boolean)
      .join(', ');
    const upstream = http.request(
      {
        host: '127.0.0.1',
        port: ports[target],
        path: req.url,
        method: req.method,
        headers: { ...req.headers, 'x-forwarded-for': forwardedFor },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, {
          ...upstreamRes.headers,
          'x-upstream': String(target),
        });
        upstreamRes.pipe(res);
      },
    );
    upstream.on('error', () => res.writeHead(502).end());
    req.pipe(upstream);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

interface Reply {
  status: number;
  upstream: string;
}

// localAddress lets one machine act as several clients (127.0.0.x is all loopback).
function get(
  port: number,
  options: { localAddress?: string; headers?: Record<string, string> } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    http
      .get(
        { host: '127.0.0.1', port, path: '/limited', agent: false, ...options },
        (res) => {
          res.resume();
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              upstream: String(res.headers['x-upstream']),
            }),
          );
        },
      )
      .on('error', reject);
  });
}

describe('Multiple instances behind a load balancer (e2e)', () => {
  const apps: NestExpressApplication[] = [];
  let loadBalancer: http.Server;
  let lbPort: number;
  let redis: Redis;

  beforeAll(async () => {
    for (let i = 0; i < INSTANCES; i++) {
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      assertLocalRedis(
        moduleRef.get(ConfigService).getOrThrow<string>('REDIS_URL'),
      );
      const app = moduleRef.createNestApplication<NestExpressApplication>();
      applyTrustProxy(app, '1'); // exactly one proxy in front, as in production
      await app.listen(0, '127.0.0.1');
      apps.push(app);
    }
    const ports = apps.map(
      (app) => (app.getHttpServer().address() as AddressInfo).port,
    );
    loadBalancer = await startLoadBalancer(ports);
    lbPort = (loadBalancer.address() as AddressInfo).port;
    redis = apps[0].get<Redis>(REDIS_CLIENT);
  });

  beforeEach(async () => {
    const keys = await redis.keys('rl:GET:/limited:*');
    if (keys.length) await redis.del(...keys);
  });

  afterAll(async () => {
    await new Promise((resolve) => loadBalancer.close(resolve));
    await Promise.all(apps.map((app) => app.close()));
  });

  it('runs separate instances with separate Redis connections', () => {
    const clients = new Set(apps.map((app) => app.get<Redis>(REDIS_CLIENT)));
    expect(clients.size).toBe(INSTANCES);
  });

  it('shares one count across instances: each serves one request, the 4th is refused', async () => {
    const replies: Reply[] = [];
    for (let i = 0; i < 4; i++) replies.push(await get(lbPort));

    expect(replies.map((r) => r.upstream)).toEqual(['0', '1', '2', '0']);
    // Instance 0 has seen only one earlier request, yet refuses: the count lives in Redis.
    expect(replies.map((r) => r.status)).toEqual([200, 200, 200, 429]);
  });

  it('admits exactly 3 of 60 concurrent requests spread over all instances (no race)', async () => {
    const replies = await Promise.all(
      Array.from({ length: 60 }, () => get(lbPort)),
    );

    expect(new Set(replies.map((r) => r.upstream)).size).toBe(INSTANCES);
    expect(replies.filter((r) => r.status === 200)).toHaveLength(3);
    expect(replies.filter((r) => r.status === 429)).toHaveLength(57);
  });

  it('gives each client its own limit, using the IP the load balancer forwarded', async () => {
    for (const localAddress of ['127.0.0.1', '127.0.0.2']) {
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) {
        statuses.push((await get(lbPort, { localAddress })).status);
      }
      expect(statuses).toEqual([200, 200, 200, 429]);
    }
  });

  it('ignores X-Forwarded-For values the client made up', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const reply = await get(lbPort, {
        headers: { 'X-Forwarded-For': `10.0.0.${i}` },
      });
      statuses.push(reply.status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
  });
});
