import {
    Entity,
    PrimaryColumn,
    Column,
} from 'typeorm';

@Entity('app_settings')
export class AppSettings {
    @PrimaryColumn({ default: 'global' })
    id: string;

    @Column({ default: 512 })
    maxUploadSizeMB: number;

    @Column({ default: 'localhost' })
    baseDomain: string;

    @Column()
    servDir: string;
}
