import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddComposeSupport1772635000000 implements MigrationInterface {
    name = 'AddComposeSupport1772635000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "projects"
            ADD COLUMN IF NOT EXISTS "useCompose" boolean NOT NULL DEFAULT false
        `);
        await queryRunner.query(`
            ALTER TABLE "projects"
            ADD COLUMN IF NOT EXISTS "composeFile" varchar NULL
        `);
        await queryRunner.query(`
            ALTER TABLE "projects"
            ADD COLUMN IF NOT EXISTS "composeService" varchar NULL
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN IF EXISTS "composeService"`);
        await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN IF EXISTS "composeFile"`);
        await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN IF EXISTS "useCompose"`);
    }
}
