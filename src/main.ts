import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { applyTrustProxy } from './trust-proxy';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  applyTrustProxy(
    app,
    app.get(ConfigService).get<string>('TRUST_PROXY_HOPS', '0'),
  );
  // Runs onApplicationShutdown hooks (e.g. closing Redis) on SIGTERM/SIGINT.
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
