import {
  ExecutionContext,
  HttpException,
  HttpStatus,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RateLimit } from '../decorators/rate-limit.decorator';
import { RateLimiterService } from '../services/rate-limiter.service';
import { RateLimiterGuard } from './rate-limiter.guard';

class DemoController {
  @RateLimit({ limit: 3, ttlSec: 10 })
  limited(): void {}

  open(): void {}

  @RateLimit({ limit: 3, ttlSec: 10, failOpen: true })
  openOnOutage(): void {}
}

type FakeRequest = {
  method?: string;
  route?: { path: string };
  ip?: string;
  user?: { id?: string | number };
};

function contextFor(
  handler: 'limited' | 'open' | 'openOnOutage',
  req: FakeRequest,
) {
  const headers: Record<string, unknown> = {};
  const res = {
    setHeader: (name: string, value: unknown) => {
      headers[name] = value;
    },
  };
  const fullReq = { method: 'GET', route: { path: '/demo' }, ...req };
  const context = {
    getHandler: () => DemoController.prototype[handler],
    getClass: () => DemoController,
    switchToHttp: () => ({
      getRequest: () => fullReq,
      getResponse: () => res,
    }),
  } as unknown as ExecutionContext;
  return { context, headers };
}

describe('RateLimiterGuard', () => {
  let consume: jest.Mock;
  let guard: RateLimiterGuard;

  beforeEach(() => {
    consume = jest
      .fn()
      .mockResolvedValue({ allowed: true, remaining: 2, resetSec: 10 });
    guard = new RateLimiterGuard(new Reflector(), {
      consume,
    } as unknown as RateLimiterService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('skips handlers without @RateLimit', async () => {
    const { context } = contextFor('open', { ip: '1.2.3.4' });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(consume).not.toHaveBeenCalled();
  });

  it('keys anonymous clients by method, route pattern and IP, and sets headers', async () => {
    const { context, headers } = contextFor('limited', {
      method: 'POST',
      route: { path: '/users/:id' },
      ip: '1.2.3.4',
    });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(consume).toHaveBeenCalledWith(
      'rl:POST:/users/:id:ip:1.2.3.4',
      3,
      10,
    );
    expect(headers).toEqual({
      'X-RateLimit-Limit': 3,
      'X-RateLimit-Remaining': 2,
      'X-RateLimit-Reset': 10,
    });
  });

  it('counts HEAD in the GET bucket, since Express runs the GET handler for it', async () => {
    await guard.canActivate(
      contextFor('limited', { method: 'HEAD', ip: '1.2.3.4' }).context,
    );
    expect(consume).toHaveBeenCalledWith('rl:GET:/demo:ip:1.2.3.4', 3, 10);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'keeps %s in its own bucket',
    async (method) => {
      await guard.canActivate(
        contextFor('limited', { method, ip: '1.2.3.4' }).context,
      );
      expect(consume).toHaveBeenCalledWith(
        `rl:${method}:/demo:ip:1.2.3.4`,
        3,
        10,
      );
    },
  );

  it('keys authenticated users by id, including id 0', async () => {
    await guard.canActivate(
      contextFor('limited', { ip: '1.2.3.4', user: { id: 0 } }).context,
    );
    expect(consume).toHaveBeenCalledWith('rl:GET:/demo:user:0', 3, 10);
  });

  it('keeps a user id and an equal-looking IP in separate buckets', async () => {
    await guard.canActivate(
      contextFor('limited', { user: { id: '1.2.3.4' } }).context,
    );
    await guard.canActivate(contextFor('limited', { ip: '1.2.3.4' }).context);
    const [[userKey], [ipKey]] = consume.mock.calls as [string][];
    expect(userKey).not.toBe(ipKey);
  });

  it('counts a request once even if the guard runs twice (class + method @RateLimit)', async () => {
    const { context } = contextFor('limited', { ip: '1.2.3.4' });
    await guard.canActivate(context);
    await guard.canActivate(context);
    expect(consume).toHaveBeenCalledTimes(1);
  });

  it('throws 429 with Retry-After when the limit is reached', async () => {
    consume.mockResolvedValue({ allowed: false, remaining: 0, resetSec: 7 });
    const { context, headers } = contextFor('limited', { ip: '1.2.3.4' });

    const error = await guard.canActivate(context).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(
      HttpStatus.TOO_MANY_REQUESTS,
    );
    expect(headers['Retry-After']).toBe(7);
  });

  it('fails closed with 503 and logs one line without a stack trace', async () => {
    const logError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    consume.mockRejectedValue(new Error('Connection is closed.'));
    const { context } = contextFor('limited', { ip: '1.2.3.4' });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(logError).toHaveBeenCalledWith(
      'Rate limit check failed for rl:GET:/demo:ip:1.2.3.4, failing closed: Connection is closed.',
    );
  });

  it('fails open when the route opts in with failOpen: true', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    consume.mockRejectedValue(new Error('Connection is closed.'));
    const { context, headers } = contextFor('openOnOutage', { ip: '1.2.3.4' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    // No counts were possible, so no rate-limit headers are sent.
    expect(headers).toEqual({});
  });
});
