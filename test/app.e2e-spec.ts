import { Test, TestingModule } from '@nestjs/testing';
import { Controller, Get, INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { RateLimit } from './../src/rate-limiter/decorators/rate-limit.decorator';
import { RateLimiterModule } from './../src/rate-limiter/rate-limiter.module';
import { REDIS_CLIENT } from './../src/redis/redis.module';
import { assertLocalRedis } from './local-redis';

// Class and method limits together: the guard is attached twice but must count once.
@Controller('nested')
@RateLimit({ limit: 100, ttlSec: 10 })
class NestedController {
  @Get()
  @RateLimit({ limit: 2, ttlSec: 10 })
  get(): string {
    return 'ok';
  }

  @Get('public')
  @RateLimit({ limit: 2, ttlSec: 10, failOpen: true })
  getPublic(): string {
    return 'ok';
  }
}

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;
  let redis: Redis;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule, RateLimiterModule],
      controllers: [NestedController],
    }).compile();
    assertLocalRedis(
      moduleFixture.get(ConfigService).getOrThrow<string>('REDIS_URL'),
    );

    app = moduleFixture.createNestApplication();
    // Listen once; otherwise supertest starts the server per request and the 50-request burst leaks listeners.
    await app.listen(0);
    redis = app.get<Redis>(REDIS_CLIENT);
  });

  beforeEach(async () => {
    const keys = await redis.keys('rl:GET:*');
    if (keys.length) await redis.del(...keys);
  });

  afterAll(async () => {
    await app.close();
  });

  it('/ (GET) is not rate limited', async () => {
    for (let i = 0; i < 5; i++) {
      await request(app.getHttpServer())
        .get('/')
        .expect(200)
        .expect('Hello World!');
    }
  });

  it('/limited allows 3 sequential requests, then 429 with headers', async () => {
    for (let remaining = 2; remaining >= 0; remaining--) {
      await request(app.getHttpServer())
        .get('/limited')
        .expect(200)
        .expect('X-RateLimit-Limit', '3')
        .expect('X-RateLimit-Remaining', String(remaining));
    }

    const res = await request(app.getHttpServer()).get('/limited').expect(429);
    expect(res.headers['x-ratelimit-remaining']).toBe('0');
    const retryAfter = Number(res.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(10);
  });

  it('/limited shares one quota between GET and HEAD: 3 GET, then HEAD is refused', async () => {
    for (let i = 0; i < 3; i++) {
      await request(app.getHttpServer()).get('/limited').expect(200);
    }
    await request(app.getHttpServer()).head('/limited').expect(429);
  });

  it('/limited shares one quota between GET and HEAD: 3 HEAD, then GET is refused', async () => {
    for (let i = 0; i < 3; i++) {
      await request(app.getHttpServer()).head('/limited').expect(200);
    }
    await request(app.getHttpServer()).get('/limited').expect(429);
  });

  it('/limited admits exactly 3 of 50 concurrent requests (no race)', async () => {
    const server = app.getHttpServer();
    const responses = await Promise.all(
      Array.from({ length: 50 }, () => request(server).get('/limited')),
    );
    const statuses = responses.map((r) => r.status);

    expect(statuses.filter((s) => s === 200)).toHaveLength(3);
    expect(statuses.filter((s) => s === 429)).toHaveLength(47);
  });

  it('/limited still works after the script cache is flushed (EVAL fallback)', async () => {
    await redis.script('FLUSH');
    await request(app.getHttpServer()).get('/limited').expect(200);
  });

  it('/nested counts each request once under class + method @RateLimit', async () => {
    for (const remaining of ['1', '0']) {
      await request(app.getHttpServer())
        .get('/nested')
        .expect(200)
        .expect('X-RateLimit-Limit', '2')
        .expect('X-RateLimit-Remaining', remaining);
    }
    await request(app.getHttpServer()).get('/nested').expect(429);
  });

  it('/limited ignores a spoofed X-Forwarded-For (trust proxy off by default)', async () => {
    for (let i = 0; i < 3; i++) {
      await request(app.getHttpServer())
        .get('/limited')
        .set('X-Forwarded-For', `10.0.0.${i}`)
        .expect(200);
    }
    await request(app.getHttpServer())
      .get('/limited')
      .set('X-Forwarded-For', '10.0.0.99')
      .expect(429);
  });

  it('while Redis is unreachable: default routes fail closed, failOpen routes stay up', async () => {
    redis.disconnect();
    try {
      await request(app.getHttpServer()).get('/limited').expect(503);
      await request(app.getHttpServer()).get('/').expect(200);
      // Unmetered: more than its limit of 2 gets through while Redis is down.
      for (let i = 0; i < 3; i++) {
        const res = await request(app.getHttpServer())
          .get('/nested/public')
          .expect(200);
        expect(res.headers['x-ratelimit-limit']).toBeUndefined();
      }
    } finally {
      await redis.connect();
    }
    await request(app.getHttpServer()).get('/limited').expect(200);
  });
});
