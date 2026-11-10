import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    ManyToOne,
} from 'typeorm';
import { Project } from './Project';

@Entity('custom_domains')
export class CustomDomain {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ unique: true })
    domain: string;

    @Column({ default: false })
    sslProvisioned: boolean;

    @Column({ default: false })
    verified: boolean;

    @Column({ type: 'varchar', nullable: true })
    redirectTarget: string | null;

    /** Absolute paths to a supplied certificate and key; used by wildcard domains. */
    @Column({ type: 'varchar', nullable: true })
    tlsCertPath: string | null;

    @Column({ type: 'varchar', nullable: true })
    tlsKeyPath: string | null;

    @ManyToOne(() => Project, (project) => project.customDomains, { onDelete: 'CASCADE' })
    project: Project;

    @Column()
    projectId: string;

    @CreateDateColumn()
    createdAt: Date;
}
