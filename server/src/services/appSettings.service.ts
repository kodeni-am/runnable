// Accessor for the app_settings singleton row. The row is created lazily
// because nothing seeds it at install time.
import { AppDataSource } from '../config/data-source';
import { AppSettings } from '../entities/AppSettings';
import { config } from '../config';

const settingsRepo = () => AppDataSource.getRepository(AppSettings);

export class AppSettingsService {
    static async get(): Promise<AppSettings> {
        const repo = settingsRepo();
        let row = await repo.findOneBy({ id: 'global' });
        if (!row) {
            row = repo.create({
                id: 'global',
                baseDomain: config.hosting.baseDomain,
                servDir: config.hosting.servDir,
            });
            await repo.save(row);
        }
        return row;
    }

    static async update(partial: Partial<Pick<AppSettings, 'buildCacheKeepGB' | 'maxUploadSizeMB' | 'baseDomain'>>): Promise<AppSettings> {
        const repo = settingsRepo();
        const row = await AppSettingsService.get();
        Object.assign(row, partial);
        return repo.save(row);
    }
}
