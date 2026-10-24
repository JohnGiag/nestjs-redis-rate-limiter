import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REDIS_CLIENT } from '../../redis/redis.module';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetSec: number;
}

@Injectable()
export class RateLimiterService implements OnModuleInit {
  private readonly script = readFileSync(
    join(__dirname, '..', 'lua', 'sliding-window.lua'),
    'utf8',
  );
  private sha: string;

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onModuleInit(): Promise<void> {
    this.sha = (await this.redis.script('LOAD', this.script)) as string;
  }

  async consume(
    key: string,
    limit: number,
    ttlSec: number,
  ): Promise<RateLimitResult> {
    // Round: 1.1 * 1000 is 1100.0000000000002, and PEXPIRE only accepts integers.
    const windowMs = Math.round(ttlSec * 1000);
    const args = [1, key, limit, windowMs, randomUUID()] as const;
    let reply: unknown;
    try {
      reply = await this.redis.evalsha(this.sha, ...args);
    } catch (err) {
      // The script cache is wiped by SCRIPT FLUSH or a Redis restart/failover.
      if (!(err instanceof Error) || !err.message.startsWith('NOSCRIPT')) {
        throw err;
      }
      reply = await this.redis.eval(this.script, ...args);
    }
    const [allowed, remaining, resetSec] = reply as [number, number, number];
    return { allowed: allowed === 1, remaining, resetSec };
  }
}
