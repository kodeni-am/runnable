import { describe, it, expect } from 'vitest';
import { AppDataSource } from '../data-source';
import { AddPreviewColumns1772639000000 } from '../../migrations/1772639000000-AddPreviewColumns';
import { AddBuildCacheKeepGB1772640000000 } from '../../migrations/1772640000000-AddBuildCacheKeepGB';

describe('data-source migrations', () => {
    it('registers the preview-columns migration', () => {
        const migrations = AppDataSource.options.migrations as Function[];
        expect(migrations).toContain(AddPreviewColumns1772639000000);
    });

    it('registers the build-cache-keep migration', () => {
        const migrations = AppDataSource.options.migrations as Function[];
        expect(migrations).toContain(AddBuildCacheKeepGB1772640000000);
    });
});
