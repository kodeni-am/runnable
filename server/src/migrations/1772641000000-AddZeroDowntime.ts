import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddZeroDowntime1772641000000 implements MigrationInterface {
    name = 'AddZeroDowntime1772641000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "zeroDowntime" boolean NOT NULL DEFAULT true`);
        await queryRunner.query(`ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "strategy" character varying`);
        await queryRunner.query(`ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "stillServing" boolean`);
        await queryRunner.query(`ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "durationMs" integer`);
        await queryRunner.query(`ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "healthGate" character varying`);
        await queryRunner.query(`ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "strategyReason" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "deployments" DROP COLUMN IF EXISTS "strategyReason"`);
        await queryRunner.query(`ALTER TABLE "deployments" DROP COLUMN IF EXISTS "healthGate"`);
        await queryRunner.query(`ALTER TABLE "deployments" DROP COLUMN IF EXISTS "durationMs"`);
        await queryRunner.query(`ALTER TABLE "deployments" DROP COLUMN IF EXISTS "stillServing"`);
        await queryRunner.query(`ALTER TABLE "deployments" DROP COLUMN IF EXISTS "strategy"`);
        await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN IF EXISTS "zeroDowntime"`);
    }
}
