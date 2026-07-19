import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddWebAuthnCredentials1772642000000 implements MigrationInterface {
    name = 'AddWebAuthnCredentials1772642000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "webauthn_credentials" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "userId" uuid NOT NULL,
                "credentialId" text NOT NULL,
                "publicKey" text NOT NULL,
                "counter" bigint NOT NULL DEFAULT 0,
                "transports" text,
                "deviceType" character varying NOT NULL DEFAULT 'singleDevice',
                "backedUp" boolean NOT NULL DEFAULT false,
                "name" character varying(64) NOT NULL,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "lastUsedAt" TIMESTAMP,
                CONSTRAINT "PK_webauthn_credentials_id" PRIMARY KEY ("id"),
                CONSTRAINT "UQ_webauthn_credentials_credentialId" UNIQUE ("credentialId"),
                CONSTRAINT "FK_webauthn_credentials_userId" FOREIGN KEY ("userId")
                    REFERENCES "users"("id") ON DELETE CASCADE
            )
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_webauthn_credentials_userId"
            ON "webauthn_credentials" ("userId")
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "webauthn_credentials"`);
    }
}
