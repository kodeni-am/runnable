import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNotificationsAndAutoRestart1772637000000 implements MigrationInterface {
    name = 'AddNotificationsAndAutoRestart1772637000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "projects"
            ADD COLUMN IF NOT EXISTS "notificationWebhookUrl" varchar NULL
        `);
        await queryRunner.query(`
            ALTER TABLE "projects"
            ADD COLUMN IF NOT EXISTS "autoRestart" boolean NOT NULL DEFAULT false
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN IF EXISTS "autoRestart"`);
        await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN IF EXISTS "notificationWebhookUrl"`);
    }
}
