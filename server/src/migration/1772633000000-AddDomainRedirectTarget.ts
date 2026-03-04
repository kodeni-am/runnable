import { MigrationInterface, QueryRunner, TableColumn } from "typeorm";

export class AddDomainRedirectTarget1772633000000 implements MigrationInterface {
    name = 'AddDomainRedirectTarget1772633000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.addColumn("custom_domains", new TableColumn({
            name: "redirectTarget",
            type: "varchar",
            isNullable: true
        }));
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropColumn("custom_domains", "redirectTarget");
    }
}
