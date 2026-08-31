import 'dotenv/config';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { databaseSsl, databaseUrl, loadEnv } from './env';

/**
 * The single TypeORM configuration, shared by the Nest application and the
 * `typeorm` CLI (which imports the default export below).
 *
 * NFR-17 — `synchronize` is false and must stay false. This schema carries
 * roughly fifteen constraints TypeORM cannot model (composite foreign keys,
 * DEFERRABLE clauses, partial indexes, generated columns); a schema sync drops
 * everything it does not know about, which would silently delete the rules that
 * enforce BR-50, BR-53, BR-58, BR-62 and the whole code-pinning scheme.
 */
export function buildDataSourceOptions(): DataSourceOptions {
  const env = loadEnv();

  return {
    type: 'postgres',
    url: databaseUrl(env),

    // NFR-07. `false` for a loopback database, TLS for anything remote — see
    // databaseSsl(). TypeORM forwards this straight to the pg pool.
    ssl: databaseSsl(env),

    // NFR-17: never, in any environment.
    synchronize: false,
    // Migrations are applied explicitly via `npm run migration:run`, never on boot.
    migrationsRun: false,

    entities: [__dirname + '/../modules/**/*.entity{.ts,.js}'],
    migrations: [__dirname + '/../database/migrations/*{.ts,.js}'],
    migrationsTableName: 'migrations',

    logging: env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],

    // NFR-05: the driver must not shift timestamps. Values are stored UTC and
    // rendered Asia/Dhaka at the edge, never by the connection.
    extra: {
      max: 10,
      // Fail fast rather than queueing forever behind an unreachable database.
      connectionTimeoutMillis: 5000,
    },
  };
}

/** Default export is what the TypeORM CLI loads. */
const dataSource = new DataSource(buildDataSourceOptions());
export default dataSource;
