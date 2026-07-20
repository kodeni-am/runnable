import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNpmRegistry1772643000000 implements MigrationInterface {
    name = 'AddNpmRegistry1772643000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "projects"
            ADD COLUMN IF NOT EXISTS "npmRegistryUrl" character varying,
            ADD COLUMN IF NOT EXISTS "npmRegistryScope" character varying,
            ADD COLUMN IF NOT EXISTS "npmAuthTokenEncrypted" text
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "projects"
            DROP COLUMN IF EXISTS "npmRegistryUrl",
            DROP COLUMN IF EXISTS "npmRegistryScope",
            DROP COLUMN IF EXISTS "npmAuthTokenEncrypted"
        `);
    }
}
