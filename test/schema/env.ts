/**
 * The schema suite runs against a real PostgreSQL — see harness.ts for why
 * mocking would verify nothing here. NODE_ENV=test routes the DataSource to
 * DATABASE_URL_TEST so the suite can truncate freely.
 */
import 'dotenv/config';

process.env.NODE_ENV = 'test';

if (!process.env.DATABASE_URL_TEST) {
  throw new Error(
    'DATABASE_URL_TEST must be set to run the schema suite. ' +
      'Create the database first: createdb fashion_express_test',
  );
}
