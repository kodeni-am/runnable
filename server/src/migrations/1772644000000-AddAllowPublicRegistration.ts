import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAllowPublicRegistration1772644000000 implements MigrationInterface {
    name = 'AddAllowPublicRegistration1772644000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Defaults to false, which closes self-service signup on existing
        // instances the moment this ships. That is deliberate — an admin can
        // re-enable it from Settings once they want signups.
        await queryRunner.query(`
            ALTER TABLE "app_settings"
            ADD COLUMN IF NOT EXISTS "allowPublicRegistration" boolean NOT NULL DEFAULT false
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "app_settings" DROP COLUMN IF EXISTS "allowPublicRegistration"`);
    }
}
