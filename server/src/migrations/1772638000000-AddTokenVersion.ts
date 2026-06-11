import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTokenVersion1772638000000 implements MigrationInterface {
    name = 'AddTokenVersion1772638000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "users"
            ADD COLUMN IF NOT EXISTS "tokenVersion" integer NOT NULL DEFAULT 0
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "tokenVersion"`);
    }
}
