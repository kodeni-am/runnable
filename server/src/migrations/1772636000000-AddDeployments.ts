import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDeployments1772636000000 implements MigrationInterface {
    name = 'AddDeployments1772636000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "deployments" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "projectId" uuid NOT NULL,
                "commitSha" varchar NULL,
                "commitMessage" text NULL,
                "branch" varchar NOT NULL DEFAULT 'main',
                "status" varchar NOT NULL,
                "trigger" varchar NOT NULL,
                "error" text NULL,
                "createdAt" timestamp NOT NULL DEFAULT now(),
                CONSTRAINT "PK_deployments_id" PRIMARY KEY ("id"),
                CONSTRAINT "FK_deployments_project" FOREIGN KEY ("projectId")
                    REFERENCES "projects"("id") ON DELETE CASCADE
            )
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_deployments_projectId" ON "deployments" ("projectId")
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "deployments"`);
    }
}
