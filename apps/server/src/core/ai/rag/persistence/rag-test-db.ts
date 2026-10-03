import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CamelCasePlugin,
  FileMigrationProvider,
  Kysely,
  Migrator,
  sql,
} from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import * as postgres from 'postgres';
import { DbInterface } from '@docmost/db/types/db.interface';

/**
 * Disposable Postgres database for RAG repository tests. The full migration
 * chain runs so foreign keys and generated columns are real. Set
 * RAG_TEST_DATABASE_URL (or DATABASE_URL) to enable these tests; they skip
 * otherwise. The database is dropped afterwards.
 */

const baseUrl = process.env.RAG_TEST_DATABASE_URL ?? process.env.DATABASE_URL;

export const ragTestDbConfigured = Boolean(baseUrl);

/**
 * Mirrors the bigint type config in database.module.ts so focused regressions
 * can read int8 columns as numbers exactly like the production pool. The
 * default helper pool keeps the driver's string parsing.
 */
const productionBigintParse = {
  types: {
    bigint: {
      to: 20,
      from: [20, 1700],
      serialize: (value: number) => value.toString(),
      parse: (value: string) => Number.parseInt(value),
    },
  },
};

export async function withRagTestDb(
  run: (db: Kysely<DbInterface>) => Promise<void>,
  options?: { productionBigintParse?: boolean },
): Promise<void> {
  if (!baseUrl) {
    throw new Error(
      'RAG repository tests require RAG_TEST_DATABASE_URL or DATABASE_URL',
    );
  }
  const admin = postgres(baseUrl, { max: 1 });
  const dbName = `rag_like237_test_${process.pid}_${randomUUID().slice(0, 8)}`;
  await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  const pool = postgres(url.toString(), {
    max: 5,
    ...(options?.productionBigintParse ? productionBigintParse : {}),
  });
  // Migrations run on a pluginless instance like src/database/migrate.ts; the
  // test instance mirrors database.module.ts with the CamelCasePlugin so
  // camelCase table names map to the snake_case schema. The migration Kysely
  // instance gets its own pool: destroying it ends that pool, and the test
  // pool below must never be reused after a destroy.
  const migrationPool = postgres(url.toString(), { max: 1 });
  const migrationDb = new Kysely<any>({
    dialect: new PostgresJSDialect({ postgres: migrationPool }),
  });
  const migrator = new Migrator({
    db: migrationDb,
    provider: new FileMigrationProvider({
      fs: { readdir: (dir: string) => fs.promises.readdir(dir) },
      path,
      migrationFolder: path.join(__dirname, '../../../../database/migrations'),
    }),
  });
  const { error } = await migrator.migrateToLatest();
  await migrationDb.destroy().catch(() => undefined);
  if (error) {
    await pool.end().catch(() => undefined);
    await admin
      .unsafe(`DROP DATABASE "${dbName}" WITH (FORCE)`)
      .catch(() => undefined);
    await admin.end();
    throw error;
  }
  const db = new Kysely<DbInterface>({
    dialect: new PostgresJSDialect({ postgres: pool }),
    plugins: [new CamelCasePlugin()],
  });
  try {
    await run(db);
  } finally {
    await db.destroy();
    await pool.end();
    await admin.unsafe(`DROP DATABASE "${dbName}" WITH (FORCE)`);
    await admin.end();
  }
}

export async function seedWorkspace(
  db: Kysely<DbInterface>,
  workspaceId: string,
): Promise<void> {
  await db
    .insertInto('workspaces')
    .values({ id: workspaceId, name: 'rag-test' })
    .execute();
}

/**
 * Seed a real space + page row so rag_generations' pages foreign key holds.
 */
export async function seedPage(
  db: Kysely<DbInterface>,
  workspaceId: string,
  pageId: string,
): Promise<void> {
  const spaceId = randomUUID();
  await db
    .insertInto('spaces')
    .values({ id: spaceId, workspaceId, slug: randomUUID(), name: 'rag-test' })
    .execute();
  await db
    .insertInto('pages')
    .values({
      id: pageId,
      workspaceId,
      spaceId,
      slugId: randomUUID().slice(0, 10),
    })
    .execute();
}

export async function countRows(
  db: Kysely<DbInterface>,
  table: 'ragOutbox' | 'ragSourceState',
): Promise<number> {
  const result = await sql<{ count: string }>`
    select count(*)::text as count from ${sql.table(table)}
  `.execute(db);
  return Number(result.rows[0]?.count ?? '0');
}
