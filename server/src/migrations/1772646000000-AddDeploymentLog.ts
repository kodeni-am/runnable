import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDeploymentLog1772646000000 implements MigrationInterface {
    name = 'AddDeploymentLog1772646000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "log" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "deployments" DROP COLUMN IF EXISTS "log"`);
    }
}
