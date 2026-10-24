import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { RateLimiterModule } from './rate-limiter/rate-limiter.module';
import { RedisModule } from './redis/redis.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    RedisModule,
    RateLimiterModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
