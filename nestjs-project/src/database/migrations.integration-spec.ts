import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { createTestDataSource } from '../test/create-test-data-source';

const MANAGED_TABLES = [
  'users',
  'channels',
  'refresh_tokens',
  'verification_tokens',
];

const MANAGED_MIGRATION_NAMES = [
  'CreateUsersAndChannels1775687773260',
  'CreateAuthTokens1777579850478',
];

// Videos' FK to channels — CASCADE-dropping "channels" below strips this
// constraint as a side effect (dropping a table doesn't drop dependent tables,
// but it does drop constraints/columns that depend on it). Restored in
// afterAll using the exact definition from CreateVideos' migration.
const VIDEOS_CHANNEL_FK = {
  name: 'FK_16909a0ae1ace805503fe874dde',
  sql: `ALTER TABLE "videos" ADD CONSTRAINT "FK_16909a0ae1ace805503fe874dde" FOREIGN KEY ("channelId") REFERENCES "channels"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
};

describe('Database migrations (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [User, Channel, RefreshToken, VerificationToken],
      {
        synchronize: false,
        migrations: [
          CreateUsersAndChannels1775687773260,
          CreateAuthTokens1777579850478,
        ],
      },
    );

    await dataSource.initialize();

    // Drop only what this test owns. Table drops first (so the enum type has
    // no remaining dependents), then the enum type itself — CreateAuthTokens'
    // migration hardcodes `"public"."verification_tokens_type_enum"`, so
    // unlike the tables it can't be schema-isolated; it must be dropped and
    // recreated in place. Finally, remove only this test's own tracking rows
    // from "migrations" — NOT the whole table — so unrelated migrations (e.g.
    // CreateVideos, and any future ones) keep their tracking intact.
    await MANAGED_TABLES.reduce(
      (prev, table) =>
        prev.then(() =>
          dataSource.query(`DROP TABLE IF EXISTS "${table}" CASCADE`),
        ),
      Promise.resolve(),
    );
    await dataSource.query(
      `DROP TYPE IF EXISTS "verification_tokens_type_enum"`,
    );
    await dataSource.query(
      `DELETE FROM "migrations" WHERE "name" = ANY($1::text[])`,
      [MANAGED_MIGRATION_NAMES],
    );
  });

  afterAll(async () => {
    // The second test undoes the last migration, leaving token tables missing.
    // Re-apply so the shared DB is fully migrated when subsequent suites run.
    await dataSource.runMigrations();

    // Restore the FK the CASCADE drop above stripped from "videos", if that
    // table exists in this checkout (phase-03+) and the FK isn't already
    // present (idempotent — safe even if a future revision of this test
    // leaves it intact).
    const videosTable = await dataSource.query<{ exists: boolean }[]>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'videos'
       ) AS "exists"`,
    );
    if (videosTable[0]?.exists) {
      const existingFk = await dataSource.query<{ count: string }[]>(
        `SELECT COUNT(*) AS count FROM information_schema.table_constraints
         WHERE constraint_name = $1`,
        [VIDEOS_CHANNEL_FK.name],
      );
      if (Number(existingFk[0]?.count ?? '0') === 0) {
        await dataSource.query(VIDEOS_CHANNEL_FK.sql);
      }
    }

    await dataSource.destroy();
  });

  it('should apply all migrations and create all four tables', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations).toHaveLength(2);

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [MANAGED_TABLES],
    );
    const tableNames = result.map((r) => r.table_name);
    expect(tableNames).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
    ]);
  });

  it('should revert the last migration and remove token tables', async () => {
    await dataSource.undoLastMigration();

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])`,
      [['refresh_tokens', 'verification_tokens']],
    );
    expect(result).toHaveLength(0);
  });
});
