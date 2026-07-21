import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVideos1784514309007 implements MigrationInterface {
  name = 'CreateVideos1784514309007';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."videos_status_enum" AS ENUM('draft', 'processing', 'ready', 'error')`,
    );
    await queryRunner.query(
      `CREATE TABLE "videos" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "channelId" uuid NOT NULL, "originalFilename" character varying NOT NULL, "storageKey" character varying NOT NULL, "status" "public"."videos_status_enum" NOT NULL DEFAULT 'draft', "duration" real, "thumbnailKey" character varying, "error_message" text, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_e4c86c0cf95aff16e9fb8220f6b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_16909a0ae1ace805503fe874dd" ON "videos" ("channelId") `,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ADD CONSTRAINT "FK_16909a0ae1ace805503fe874dde" FOREIGN KEY ("channelId") REFERENCES "channels"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" DROP CONSTRAINT "FK_16909a0ae1ace805503fe874dde"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_16909a0ae1ace805503fe874dd"`,
    );
    await queryRunner.query(`DROP TABLE "videos"`);
    await queryRunner.query(`DROP TYPE "public"."videos_status_enum"`);
  }
}
