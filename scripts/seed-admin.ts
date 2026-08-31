/**
 * Seed the first staff account.
 *
 * `AuthGuard` is global (`APP_GUARD`) and `@Public()` is the only way out, so
 * `POST /users` — the route that creates staff — needs a session to reach.
 * On an empty database that is a closed loop: no user, therefore no session,
 * therefore no way to create the user. Something outside the API has to write
 * row one, and this is it.
 *
 *     npm run seed:admin
 *     npm run seed:admin -- --username owner --password 's3cret!' --force
 *
 * It is a script rather than a migration on purpose. Migrations are the
 * versioned schema record and are replayed by `npm run db:reset`; a password
 * does not belong in that history, and seeding is an operational act you may
 * want to repeat with different arguments.
 *
 * The insert mirrors `UsersService.create()` (FR-00.6) rather than inventing a
 * second way to make a user: same column list, same generated employee ID
 * (FR-00.8), same one-transaction rule so an account nobody can sign in to is
 * never left behind.
 */
import 'dotenv/config';
import { DataSource, type EntityManager } from 'typeorm';
import { authPool } from '../src/config/auth';
import { buildDataSourceOptions } from '../src/config/data-source';
import { databaseUrl, loadEnv } from '../src/config/env';
import { employeeId } from '../src/common/identifiers';
import {
  insertCredential,
  replaceCredential,
} from '../src/modules/auth/credentials';
import { firstRow } from '../src/common/sql';

interface Options {
  username: string;
  password: string;
  name: string;
  email: string;
  userType: string;
  shopId: string | null;
  force: boolean;
  allowTest: boolean;
}

const DEFAULTS: Options = {
  username: 'admin',
  password: '12345678',
  name: 'Administrator',
  // Blank rather than a fake address: the column defaults to '' and the unique
  // index on lower(email) is partial (WHERE email <> ''), so an empty value
  // stays repeatable where a placeholder would collide on the second account.
  email: '',
  // BR-56 — privilege comes from the type. `owner` is the unrestricted one
  // (is_superuser), which is what an administrator needs to open the app up.
  userType: 'owner',
  shopId: null,
  force: false,
  allowTest: false,
};

function parseArgs(argv: string[]): Options {
  const options: Options = { ...DEFAULTS };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`${arg} needs a value`);
      }
      i += 1;
      return next;
    };

    switch (arg) {
      case '--username':
        options.username = value();
        break;
      case '--password':
        options.password = value();
        break;
      case '--name':
        options.name = value();
        break;
      case '--email':
        options.email = value();
        break;
      case '--user-type':
        options.userType = value();
        break;
      case '--shop':
        options.shopId = value();
        break;
      case '--force':
        options.force = true;
        break;
      case '--allow-test':
        options.allowTest = true;
        break;
      case '--help':
      case '-h':
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}\n\n${USAGE}`);
    }
  }

  return options;
}

const USAGE = `Usage: npm run seed:admin -- [options]

  --username <name>   default: ${DEFAULTS.username}
  --password <pass>   default: ${DEFAULTS.password} (minimum 8 characters)
  --name <full name>  default: ${DEFAULTS.name}
  --email <address>   default: none
  --user-type <code>  default: ${DEFAULTS.userType}  (owner | manager | finance | employee)
  --shop <id>         default: none — the account belongs to no single shop (BR-55)
  --force             reset the password if the account already exists
  --allow-test        permit running while NODE_ENV=test`;

/**
 * Reference rows are resolved by **code**, never by the literal id. They happen
 * to be 1 and 1 today, but the ids come from a seed migration and a reseed is
 * free to renumber them; the codes are what the spec names (RD-14, RD-09).
 */
async function resolveReference(
  manager: EntityManager,
  sql: string,
  params: unknown[],
  missing: string,
): Promise<string> {
  const row = firstRow<{ id: string }>(await manager.query(sql, params));
  if (!row) throw new Error(missing);
  return row.id;
}

async function seed(dataSource: DataSource, options: Options): Promise<void> {
  const existing = firstRow<{ id: string; username: string }>(
    await dataSource.query(
      `SELECT id::text, username FROM users WHERE username = lower($1)`,
      [options.username],
    ),
  );

  if (existing && !options.force) {
    console.log(
      `\n  '${existing.username}' already exists (id ${existing.id}). Nothing written.` +
        `\n  Pass --force to reset its password.\n`,
    );
    return;
  }

  if (existing) {
    // replaceCredential goes through better-auth's own pool, which is fine here
    // — there is no user row being written alongside it to keep atomic.
    await replaceCredential(existing.id, options.password);
    console.log(
      `\n  Password reset for '${existing.username}' (id ${existing.id}).\n`,
    );
    return;
  }

  const employee = employeeId();

  const id = await dataSource.transaction(async (manager) => {
    const userTypeId = await resolveReference(
      manager,
      `SELECT id::text FROM user_types WHERE code = $1`,
      [options.userType],
      `No user type with code '${options.userType}'. Run the migrations first.`,
    );

    const statusId = await resolveReference(
      manager,
      `SELECT id::text FROM statuses WHERE scope = 'user' AND code = 'active'`,
      [],
      "No 'active' user status. Run the migrations first.",
    );

    const created = firstRow<{ id: string }>(
      await manager.query(
        `INSERT INTO users (username, display_username, name, email,
                            employee_id, user_type_id, status_id, shop_id,
                            created_by_id, updated_by_id)
         VALUES (lower($1), $1, $2, $3, $4, $5, $6, $7, NULL, NULL)
         RETURNING id::text`,
        [
          options.username,
          options.name,
          options.email,
          employee,
          userTypeId,
          statusId,
          options.shopId,
        ],
      ),
    );

    if (!created) throw new Error('The account could not be created.');

    // Same transaction as the row above: better-auth hashes (scrypt, NFR-06),
    // but this EntityManager writes, so both commit or neither does.
    await insertCredential(manager, created.id, options.password);
    return created.id;
  });

  console.log(
    `\n  Created '${options.username}' (id ${id})` +
      `\n    employee ID  ${employee}` +
      `\n    user type    ${options.userType}` +
      `\n    password     ${options.password}` +
      `\n\n  Sign in at POST /api/auth/sign-in/username.\n`,
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const env = loadEnv();

  // The test database is truncated by the suites. Writing a real account into
  // it is harmless but pointless, and the likelier mistake is the reverse — a
  // stray NODE_ENV pointing this at the wrong database entirely.
  if (env.NODE_ENV === 'test' && !options.allowTest) {
    throw new Error(
      'NODE_ENV=test targets DATABASE_URL_TEST. Pass --allow-test if that is what you meant.',
    );
  }

  // Say where the write is going before making it — the connection string is
  // whatever .env holds, and that is worth seeing.
  const target = new URL(databaseUrl(env));
  console.log(`\n  Target: ${target.hostname}${target.pathname}`);

  const dataSource = new DataSource(buildDataSourceOptions());
  await dataSource.initialize();

  try {
    await seed(dataSource, options);
  } finally {
    await dataSource.destroy();
    // better-auth holds a second pool; without this the process never exits.
    await authPool.end();
  }
}

main().catch((error: unknown) => {
  console.error(
    `\n  ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
