import { describe, it, expect } from 'vitest';
import { AppDataSource } from '../data-source';
import { AddPreviewColumns1772639000000 } from '../../migrations/1772639000000-AddPreviewColumns';

describe('data-source migrations', () => {
    it('registers the preview-columns migration', () => {
        const migrations = AppDataSource.options.migrations as Function[];
        expect(migrations).toContain(AddPreviewColumns1772639000000);
    });
});
