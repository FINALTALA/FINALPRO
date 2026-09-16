import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import * as Sentry from '@sentry/node';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

async function bootstrap() {
  // Part 6, §P: Sentry error tracking. A no-op if SENTRY_DSN isn't set
  // (e.g. local dev) - never a hard requirement to run the app.
  if (process.env.SENTRY_DSN) {
    Sentry.init({ dsn: process.env.SENTRY_DSN });
  }

  const app = await NestFactory.create(AppModule);

  // Part 4, H.1: versioned API surface.
  app.setGlobalPrefix('api/v1');

  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // Permissive for local dev; tightened when the Next.js origin is
  // known for real (staging/production config, Part 6 §P).
  app.enableCors({ origin: true, credentials: true });

  const port = process.env.API_PORT ?? 3001;
  await app.listen(port);
  Logger.log(`API listening on port ${port} (prefix: /api/v1)`, 'Bootstrap');
}
bootstrap();
