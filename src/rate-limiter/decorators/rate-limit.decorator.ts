import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import {
  RATE_LIMIT_KEY,
  RateLimiterGuard,
  RateLimitOptions,
} from '../guards/rate-limiter.guard';

export type { RateLimitOptions };

/**
 * Limits a route or controller and attaches RateLimiterGuard, so the limit can't be forgotten.
 * Put auth guards on the controller or globally: Nest runs those before method-level guards.
 * On the same method, write @RateLimit above @UseGuards(AuthGuard): decorators apply bottom-up.
 */
export const RateLimit = (options: RateLimitOptions) => {
  const { limit, ttlSec } = options;
  // Checked at class load so a typo fails startup: ttlSec 0 would silently disable the limit.
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`@RateLimit: limit must be an integer >= 1, got ${limit}`);
  }
  if (!(ttlSec * 1000 >= 1) || !Number.isFinite(ttlSec)) {
    throw new Error(`@RateLimit: ttlSec must be >= 0.001, got ${ttlSec}`);
  }
  return applyDecorators(
    SetMetadata(RATE_LIMIT_KEY, options),
    UseGuards(RateLimiterGuard),
  );
};
