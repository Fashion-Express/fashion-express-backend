import { Controller, Get } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Public } from './modules/auth/decorators';

/**
 * The one route that is deliberately anonymous (FR-00.1's exception): a load
 * balancer or container orchestrator has no session to present. It reports
 * liveness only — never anything about the data.
 */
@Public()
@Controller('health')
export class HealthController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  @Get()
  async check(): Promise<{
    status: string;
    database: string;
    migrations: number;
  }> {
    const [{ now }] = await this.dataSource.query<[{ now: string }]>(
      'SELECT now() AS now',
    );
    const applied = await this.dataSource
      .query<Array<{ count: string }>>(
        `SELECT count(*)::text AS count FROM migrations`,
      )
      .catch(() => [{ count: '0' }]);

    return {
      status: 'ok',
      database: now,
      migrations: Number(applied[0].count),
    };
  }
}
