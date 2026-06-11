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
            // Upsert: two concurrent first calls must not race to a duplicate-
            // key error on the singleton row.
            await repo.upsert(
                {
                    id: 'global',
                    baseDomain: config.hosting.baseDomain,
                    servDir: config.hosting.servDir,
                },
                { conflictPaths: ['id'], skipUpdateIfNoValuesChanged: true },
            );
            row = (await repo.findOneBy({ id: 'global' }))!;
        }
        return row;
    }

    static async update(partial: Partial<Pick<AppSettings, 'buildCacheKeepGB'>>): Promise<AppSettings> {
        const repo = settingsRepo();
        const row = await AppSettingsService.get();
        Object.assign(row, partial);
        return repo.save(row);
    }
}
