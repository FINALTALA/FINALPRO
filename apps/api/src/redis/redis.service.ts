import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

/**
 * Part 6, M.2's architecture table assigns "session storage" to Redis
 * (not a stateless JWT) - this is the thin client wrapper every
 * session/verification-token service builds on. One connection per
 * process, matching the PrismaService pattern (prisma/prisma.service.ts).
 */
@Injectable()
export class RedisService extends Redis implements OnModuleDestroy {
  constructor() {
    const url = process.env.REDIS_URL;
    if (!url) {
      throw new Error('REDIS_URL is not set');
    }
    super(url);
  }

  async onModuleDestroy() {
    // quit() (not disconnect()) waits for the QUIT reply before closing
    // the socket - disconnect() closes it abruptly and was leaving
    // e2e test workers with an open handle, forcing Jest to hard-exit.
    await this.quit();
  }
}
