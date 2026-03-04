import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1709520000000 implements MigrationInterface {
    name = 'InitialSchema1709520000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Create enum types
        await queryRunner.query(`
            DO $$ BEGIN
                CREATE TYPE "role_enum" AS ENUM ('admin', 'user');
            EXCEPTION WHEN duplicate_object THEN null;
            END $$;
        `);
        await queryRunner.query(`
            DO $$ BEGIN
                CREATE TYPE "server_type_enum" AS ENUM ('caddy', 'apache', 'nginx', 'static', 'app');
            EXCEPTION WHEN duplicate_object THEN null;
            END $$;
        `);
        await queryRunner.query(`
            DO $$ BEGIN
                CREATE TYPE "service_status_enum" AS ENUM ('running', 'stopped', 'error', 'deploying', 'building');
            EXCEPTION WHEN duplicate_object THEN null;
            END $$;
        `);

        // Users table
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "users" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "email" character varying NOT NULL,
                "username" character varying NOT NULL,
                "passwordHash" character varying,
                "role" "role_enum" NOT NULL DEFAULT 'user',
                "isApproved" boolean NOT NULL DEFAULT false,
                "githubId" character varying,
                "googleId" character varying,
                "githubToken" character varying,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "UQ_users_email" UNIQUE ("email"),
                CONSTRAINT "UQ_users_username" UNIQUE ("username"),
                CONSTRAINT "UQ_users_githubId" UNIQUE ("githubId"),
                CONSTRAINT "UQ_users_googleId" UNIQUE ("googleId"),
                CONSTRAINT "PK_users" PRIMARY KEY ("id")
            )
        `);

        // Projects table
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "projects" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "name" character varying NOT NULL,
                "subdomain" character varying NOT NULL,
                "directoryPath" character varying NOT NULL,
                "serverType" "server_type_enum" NOT NULL,
                "status" "service_status_enum" NOT NULL DEFAULT 'stopped',
                "port" integer,
                "configPath" character varying,
                "containerId" character varying,
                "internalPort" integer,
                "buildCommand" character varying,
                "startCommand" character varying,
                "envVars" text,
                "userId" uuid NOT NULL,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "UQ_projects_subdomain" UNIQUE ("subdomain"),
                CONSTRAINT "PK_projects" PRIMARY KEY ("id")
            )
        `);

        // GitHub repos table
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "github_repos" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "repoUrl" character varying NOT NULL,
                "branch" character varying NOT NULL DEFAULT 'main',
                "isPrivate" boolean NOT NULL DEFAULT false,
                "webhookId" character varying,
                "webhookSecret" character varying,
                "lastDeployAt" TIMESTAMP,
                "projectId" uuid NOT NULL,
                CONSTRAINT "REL_github_repos_projectId" UNIQUE ("projectId"),
                CONSTRAINT "PK_github_repos" PRIMARY KEY ("id")
            )
        `);

        // Custom domains table
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "custom_domains" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "domain" character varying NOT NULL,
                "sslProvisioned" boolean NOT NULL DEFAULT false,
                "verified" boolean NOT NULL DEFAULT false,
                "projectId" uuid NOT NULL,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "UQ_custom_domains_domain" UNIQUE ("domain"),
                CONSTRAINT "PK_custom_domains" PRIMARY KEY ("id")
            )
        `);

        // App settings table
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "app_settings" (
                "id" character varying NOT NULL DEFAULT 'global',
                "maxUploadSizeMB" integer NOT NULL DEFAULT 512,
                "baseDomain" character varying NOT NULL DEFAULT 'localhost',
                "servDir" character varying NOT NULL,
                CONSTRAINT "PK_app_settings" PRIMARY KEY ("id")
            )
        `);

        // Enable uuid extension
        await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

        // Foreign keys
        await queryRunner.query(`
            ALTER TABLE "projects"
            ADD CONSTRAINT "FK_projects_userId"
            FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "github_repos"
            ADD CONSTRAINT "FK_github_repos_projectId"
            FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "custom_domains"
            ADD CONSTRAINT "FK_custom_domains_projectId"
            FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "custom_domains" DROP CONSTRAINT IF EXISTS "FK_custom_domains_projectId"`);
        await queryRunner.query(`ALTER TABLE "github_repos" DROP CONSTRAINT IF EXISTS "FK_github_repos_projectId"`);
        await queryRunner.query(`ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "FK_projects_userId"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "app_settings"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "custom_domains"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "github_repos"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "projects"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "users"`);
        await queryRunner.query(`DROP TYPE IF EXISTS "service_status_enum"`);
        await queryRunner.query(`DROP TYPE IF EXISTS "server_type_enum"`);
        await queryRunner.query(`DROP TYPE IF EXISTS "role_enum"`);
    }
}
