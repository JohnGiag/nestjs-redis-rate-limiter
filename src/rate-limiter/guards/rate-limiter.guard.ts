import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import {
  RateLimiterService,
  RateLimitResult,
} from '../services/rate-limiter.service';

export interface RateLimitOptions {
  limit: number;
  ttlSec: number;
  /** When Redis is unreachable: false (default) answers 503, true lets the request through unmetered. */
  failOpen?: boolean;
}

export const RATE_LIMIT_KEY = 'rate-limit';

const CHECKED = Symbol('rateLimitChecked');

type RateLimitedRequest = Request & {
  user?: { id?: string | number };
  [CHECKED]?: true;
};

/** Attached by @RateLimit(); runs after controller-level and global guards such as auth. */
@Injectable()
export class RateLimiterGuard implements CanActivate {
  private readonly logger = new Logger(RateLimiterGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly rateLimiter: RateLimiterService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.getAllAndOverride<
      RateLimitOptions | undefined
    >(RATE_LIMIT_KEY, [context.getHandler(), context.getClass()]);
    if (!options) return true;

    const http = context.switchToHttp();
    const req = http.getRequest<RateLimitedRequest>();
    const res = http.getResponse<Response>();

    // @RateLimit on both a controller and its method attaches this guard twice; count once.
    if (req[CHECKED]) return true;
    req[CHECKED] = true;

    // req.ip honours the "trust proxy" setting (TRUST_PROXY_HOPS).
    const client =
      req.user?.id != null
        ? `user:${req.user.id}`
        : `ip:${req.ip ?? 'unknown'}`;
    // Route pattern (e.g. /users/:id), not class names: two UsersController classes must not share a bucket.
    const route =
      (req.route as { path?: string } | undefined)?.path ?? req.path;
    // Express answers HEAD with the GET handler; a separate HEAD bucket would double every GET limit.
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    const key = `rl:${method}:${route}:${client}`;

    let result: RateLimitResult;
    try {
      result = await this.rateLimiter.consume(
        key,
        options.limit,
        options.ttlSec,
      );
    } catch (err) {
      // Without Redis we cannot count. Only an explicit `true` opens the gate; anything else stays closed.
      const failOpen = options.failOpen === true;
      // Message only: a stack trace per request floods the logs during an outage.
      this.logger.error(
        `Rate limit check failed for ${key}, failing ${failOpen ? 'open' : 'closed'}: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (failOpen) return true;
      throw new ServiceUnavailableException();
    }
    const { allowed, remaining, resetSec } = result;

    res.setHeader('X-RateLimit-Limit', options.limit);
    res.setHeader('X-RateLimit-Remaining', remaining);
    res.setHeader('X-RateLimit-Reset', resetSec);

    if (!allowed) {
      res.setHeader('Retry-After', resetSec);
      throw new HttpException(
        'Too Many Requests',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
