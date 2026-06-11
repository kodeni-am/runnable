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

    // Build-cache GC cap in GB. 0 disables post-deploy enforcement.
    @Column({ default: 10 })
    buildCacheKeepGB: number;
}
