import { GUARDS_METADATA } from '@nestjs/common/constants';
import { RateLimiterGuard } from '../guards/rate-limiter.guard';
import { RateLimit } from './rate-limit.decorator';

describe('@RateLimit', () => {
  it('attaches RateLimiterGuard, so the limit cannot be left unenforced', () => {
    class Demo {
      @RateLimit({ limit: 3, ttlSec: 10 })
      handler(this: void): void {}
    }
    expect(
      Reflect.getMetadata(GUARDS_METADATA, Demo.prototype.handler),
    ).toEqual([RateLimiterGuard]);
  });

  it('accepts valid options', () => {
    expect(() => RateLimit({ limit: 3, ttlSec: 10 })).not.toThrow();
    expect(() => RateLimit({ limit: 1, ttlSec: 0.001 })).not.toThrow();
  });

  it.each([0, -1, 1.5, NaN])('rejects limit %p', (limit) => {
    expect(() => RateLimit({ limit, ttlSec: 10 })).toThrow(/limit/);
  });

  it.each([0, -1, 0.0001, NaN, Infinity])('rejects ttlSec %p', (ttlSec) => {
    expect(() => RateLimit({ limit: 3, ttlSec })).toThrow(/ttlSec/);
  });
});
