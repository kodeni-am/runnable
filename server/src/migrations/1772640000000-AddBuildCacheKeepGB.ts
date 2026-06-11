import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddBuildCacheKeepGB1772640000000 implements MigrationInterface {
    name = 'AddBuildCacheKeepGB1772640000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "app_settings"
            ADD COLUMN IF NOT EXISTS "buildCacheKeepGB" integer NOT NULL DEFAULT 10
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "app_settings" DROP COLUMN IF EXISTS "buildCacheKeepGB"`);
    }
}
