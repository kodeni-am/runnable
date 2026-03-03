import fs from 'fs/promises';
import path from 'path';
import { AppError } from '../middleware/errorHandler';

interface FileInfo {
    name: string;
    path: string;
    isDirectory: boolean;
    size: number;
    modifiedAt: Date;
}

export class FileManagerService {
    /**
     * Validate that a file path doesn't escape the project directory (path traversal protection)
     */
    private static validatePath(baseDir: string, filePath: string): string {
        const resolved = path.resolve(baseDir, filePath);
        if (!resolved.startsWith(path.resolve(baseDir))) {
            throw new AppError('Invalid file path: path traversal detected', 400);
        }
        return resolved;
    }

    static async listFiles(baseDir: string, relativePath: string = ''): Promise<FileInfo[]> {
        const targetDir = FileManagerService.validatePath(baseDir, relativePath);

        try {
            const entries = await fs.readdir(targetDir, { withFileTypes: true });
            const files: FileInfo[] = [];

            for (const entry of entries) {
                // Skip hidden files and .git
                if (entry.name.startsWith('.')) continue;

                const fullPath = path.join(targetDir, entry.name);
                const stat = await fs.stat(fullPath);

                files.push({
                    name: entry.name,
                    path: path.join(relativePath, entry.name),
                    isDirectory: entry.isDirectory(),
                    size: stat.size,
                    modifiedAt: stat.mtime,
                });
            }

            // Sort: directories first, then alphabetical
            files.sort((a, b) => {
                if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
                return a.name.localeCompare(b.name);
            });

            return files;
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                throw new AppError('Directory not found', 404);
            }
            throw error;
        }
    }

    static async uploadFile(baseDir: string, relativePath: string, tempPath: string): Promise<void> {
        const targetPath = FileManagerService.validatePath(baseDir, relativePath);

        // Ensure parent directory exists
        await fs.mkdir(path.dirname(targetPath), { recursive: true });

        // Move from temp upload location to target
        await fs.rename(tempPath, targetPath);
    }

    static async getFilePath(baseDir: string, relativePath: string): Promise<string> {
        const fullPath = FileManagerService.validatePath(baseDir, relativePath);

        try {
            await fs.access(fullPath);
            return fullPath;
        } catch {
            throw new AppError('File not found', 404);
        }
    }

    static async deleteFile(baseDir: string, relativePath: string): Promise<void> {
        const fullPath = FileManagerService.validatePath(baseDir, relativePath);

        try {
            const stat = await fs.stat(fullPath);
            if (stat.isDirectory()) {
                await fs.rm(fullPath, { recursive: true });
            } else {
                await fs.unlink(fullPath);
            }
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                throw new AppError('File not found', 404);
            }
            throw error;
        }
    }

    static async createDirectory(baseDir: string, relativePath: string): Promise<void> {
        const fullPath = FileManagerService.validatePath(baseDir, relativePath);
        await fs.mkdir(fullPath, { recursive: true });
    }
}
