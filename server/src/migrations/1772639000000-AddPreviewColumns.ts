import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPreviewColumns1772639000000 implements MigrationInterface {
    name = 'AddPreviewColumns1772639000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "previewsEnabled" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "previewBaseDomain" varchar NULL`);
        await queryRunner.query(`ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "previewEnvOverrides" text NULL`);
        await queryRunner.query(`ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "previewTtlDays" integer NOT NULL DEFAULT 7`);
        await queryRunner.query(`ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "isPreview" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "parentProjectId" uuid NULL`);
        await queryRunner.query(`ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "prNumber" integer NULL`);
        await queryRunner.query(`ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "prBranch" varchar NULL`);
        await queryRunner.query(`ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "lastActivityAt" timestamp NULL`);
        await queryRunner.query(`ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "baseDomain" varchar NULL`);

        await queryRunner.query(`
            ALTER TABLE "projects"
            ADD CONSTRAINT "FK_projects_parentProjectId"
            FOREIGN KEY ("parentProjectId") REFERENCES "projects"("id") ON DELETE CASCADE
        `);

        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_projects_parentProjectId" ON "projects" ("parentProjectId")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_projects_isPreview_lastActivityAt" ON "projects" ("isPreview", "lastActivityAt")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_projects_isPreview_lastActivityAt"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_projects_parentProjectId"`);
        await queryRunner.query(`ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "FK_projects_parentProjectId"`);
        for (const col of ['baseDomain', 'lastActivityAt', 'prBranch', 'prNumber', 'parentProjectId', 'isPreview', 'previewTtlDays', 'previewEnvOverrides', 'previewBaseDomain', 'previewsEnabled']) {
            await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN IF EXISTS "${col}"`);
        }
    }
}
