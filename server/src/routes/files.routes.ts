import { Router, Response, NextFunction } from 'express';
import path from 'path';
import { AppDataSource } from '../config/data-source';
import { Project } from '../entities';
import { ProjectPermission } from '../entities/enums';
import { authenticate, requireApproval, requireProjectAccess, AuthRequest } from '../middleware/auth';
import { upload } from '../middleware/upload';
import { AppError } from '../middleware/errorHandler';
import { FileManagerService } from '../services/fileManager.service';

const router = Router();

// All internal routes require authentication and admin approval
router.use(authenticate, requireApproval);

// List files (any collaborator can view)
router.get('/:id/files', requireProjectAccess(), async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const project = (req as any).project as Project;
        const relativePath = (req.query.path as string) || '';
        const files = await FileManagerService.listFiles(project.directoryPath, relativePath);
        res.json(files);
    } catch (error) {
        next(error);
    }
});

// Download file (any collaborator can view)
router.get('/:id/files/download', requireProjectAccess(), async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const project = (req as any).project as Project;
        const filePath = req.query.path as string;
        if (!filePath) throw new AppError('File path is required', 400);

        const fullPath = await FileManagerService.getFilePath(project.directoryPath, filePath);
        res.download(fullPath);
    } catch (error) {
        next(error);
    }
});

// Upload file(s) (requires canEditFiles)
router.post('/:id/files/upload', requireProjectAccess(ProjectPermission.CAN_EDIT_FILES), upload.array('files', 20), async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const project = (req as any).project as Project;
        const targetDir = (req.body.path as string) || '';
        const files = req.files as Express.Multer.File[];

        if (!files || files.length === 0) {
            throw new AppError('No files uploaded', 400);
        }

        for (const file of files) {
            const relativePath = path.join(targetDir, file.originalname);
            await FileManagerService.uploadFile(project.directoryPath, relativePath, file.path);
        }

        res.json({ message: `${files.length} file(s) uploaded successfully` });
    } catch (error) {
        next(error);
    }
});

// Delete file (requires canEditFiles)
router.delete('/:id/files', requireProjectAccess(ProjectPermission.CAN_EDIT_FILES), async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const project = (req as any).project as Project;
        const filePath = req.query.path as string;
        if (!filePath) throw new AppError('File path is required', 400);

        await FileManagerService.deleteFile(project.directoryPath, filePath);
        res.json({ message: 'File deleted' });
    } catch (error) {
        next(error);
    }
});

// Create directory (requires canEditFiles)
router.post('/:id/files/mkdir', requireProjectAccess(ProjectPermission.CAN_EDIT_FILES), async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const project = (req as any).project as Project;
        const { path: dirPath } = req.body;
        if (!dirPath) throw new AppError('Directory path is required', 400);

        await FileManagerService.createDirectory(project.directoryPath, dirPath);
        res.json({ message: 'Directory created' });
    } catch (error) {
        next(error);
    }
});

// Read file content (any collaborator can view)
router.get('/:id/files/read', requireProjectAccess(), async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const project = (req as any).project as Project;
        const filePath = req.query.path as string;
        if (!filePath) throw new AppError('File path is required', 400);

        const { content, size } = await FileManagerService.readFile(project.directoryPath, filePath);
        res.json({ content, size });
    } catch (error) {
        next(error);
    }
});

// Save file content (requires canEditFiles)
router.put('/:id/files/write', requireProjectAccess(ProjectPermission.CAN_EDIT_FILES), async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const project = (req as any).project as Project;
        const { path: filePath, content } = req.body;
        if (!filePath) throw new AppError('File path is required', 400);
        if (typeof content !== 'string') throw new AppError('Content must be a string', 400);

        // Limit file write size to 2MB to prevent disk exhaustion
        const MAX_WRITE_SIZE = 2 * 1024 * 1024;
        if (Buffer.byteLength(content, 'utf-8') > MAX_WRITE_SIZE) {
            throw new AppError('File content exceeds maximum size of 2MB', 413);
        }

        await FileManagerService.writeFile(project.directoryPath, filePath, content);
        res.json({ message: 'File saved' });
    } catch (error) {
        next(error);
    }
});

// Create new file (requires canEditFiles)
router.post('/:id/files/create', requireProjectAccess(ProjectPermission.CAN_EDIT_FILES), async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const project = (req as any).project as Project;
        const { path: filePath, content } = req.body;
        if (!filePath) throw new AppError('File path is required', 400);

        await FileManagerService.writeFile(project.directoryPath, filePath, content || '');
        res.json({ message: 'File created' });
    } catch (error) {
        next(error);
    }
});

export default router;

