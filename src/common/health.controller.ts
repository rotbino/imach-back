import { Controller, Get } from "@nestjs/common";
import { CacheService } from "./cache/cache.module";
import { PrismaService } from "./prisma/prisma.module";

/** GET /api/v1/getHealth — liveness + cache stats. */
@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService
  ) {}

  @Get("getHealth")
  async getHealth() {
    return {
      ok: true,
      service: "imach-back",
      time: new Date().toISOString(),
      cache: this.cache.stats(),
    };
  }
}
