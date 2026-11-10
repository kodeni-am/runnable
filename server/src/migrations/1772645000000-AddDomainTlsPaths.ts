import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDomainTlsPaths1772645000000 implements MigrationInterface {
    name = 'AddDomainTlsPaths1772645000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "custom_domains"
            ADD COLUMN IF NOT EXISTS "tlsCertPath" varchar,
            ADD COLUMN IF NOT EXISTS "tlsKeyPath" varchar
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "custom_domains"
            DROP COLUMN IF EXISTS "tlsCertPath",
            DROP COLUMN IF EXISTS "tlsKeyPath"
        `);
    }
}
