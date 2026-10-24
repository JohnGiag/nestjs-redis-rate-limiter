import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { RateLimit } from './rate-limiter/decorators/rate-limit.decorator';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('limited')
  @RateLimit({ limit: 3, ttlSec: 10 })
  getLimited(): { ok: boolean } {
    return { ok: true };
  }
}
