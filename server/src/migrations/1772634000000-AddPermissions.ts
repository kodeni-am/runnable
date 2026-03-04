import { MigrationInterface, QueryRunner, Table, TableColumn, TableUnique } from 'typeorm';

export class AddPermissions1772634000000 implements MigrationInterface {
    name = 'AddPermissions1772634000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Add permissions column to users table (idempotent)
        const usersTable = await queryRunner.getTable('users');
        if (usersTable && !usersTable.findColumnByName('permissions')) {
            await queryRunner.addColumn(
                'users',
                new TableColumn({
                    name: 'permissions',
                    type: 'text',
                    isNullable: true,
                })
            );
        }

        // Create project_collaborators table (idempotent)
        const collabTable = await queryRunner.getTable('project_collaborators');
        if (!collabTable) {
        await queryRunner.createTable(
            new Table({
                name: 'project_collaborators',
                columns: [
                    {
                        name: 'id',
                        type: 'uuid',
                        isPrimary: true,
                        generationStrategy: 'uuid',
                        default: 'uuid_generate_v4()',
                    },
                    {
                        name: 'userId',
                        type: 'uuid',
                    },
                    {
                        name: 'projectId',
                        type: 'uuid',
                    },
                    {
                        name: 'permissions',
                        type: 'text',
                    },
                    {
                        name: 'createdAt',
                        type: 'timestamp',
                        default: 'now()',
                    },
                ],
            }),
            true
        );

        // Add unique constraint on userId + projectId
        await queryRunner.createUniqueConstraint(
            'project_collaborators',
            new TableUnique({
                name: 'UQ_project_collaborator_user_project',
                columnNames: ['userId', 'projectId'],
            })
        );

        // Add foreign keys
        await queryRunner.query(
            `ALTER TABLE "project_collaborators" ADD CONSTRAINT "FK_project_collaborator_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE`
        );
        await queryRunner.query(
            `ALTER TABLE "project_collaborators" ADD CONSTRAINT "FK_project_collaborator_project" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE`
        );
        } // end if (!collabTable)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "project_collaborators" DROP CONSTRAINT "FK_project_collaborator_project"`);
        await queryRunner.query(`ALTER TABLE "project_collaborators" DROP CONSTRAINT "FK_project_collaborator_user"`);
        await queryRunner.dropTable('project_collaborators');
        await queryRunner.dropColumn('users', 'permissions');
    }
}
