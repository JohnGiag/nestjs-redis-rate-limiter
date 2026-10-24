import { Module } from '@nestjs/common';
import { RateLimiterGuard } from './guards/rate-limiter.guard';
import { RateLimiterService } from './services/rate-limiter.service';

// Import this module wherever RateLimiterGuard is used: the guard needs RateLimiterService.
@Module({
  providers: [RateLimiterService, RateLimiterGuard],
  exports: [RateLimiterService, RateLimiterGuard],
})
export class RateLimiterModule {}
