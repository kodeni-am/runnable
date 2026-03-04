import { Router, Response, NextFunction } from 'express';
import path from 'path';
import { AppDataSource } from '../config/data-source';
import { Project } from '../entities';
import { authenticate, requireApproval, AuthRequest } from '../middleware/auth';
import { upload } from '../middleware/upload';
import { AppError } from '../middleware/errorHandler';
import { FileManagerService } from '../services/fileManager.service';

const router = Router();

// All internal routes require authentication and admin approval
router.use(authenticate, requireApproval);

// List files
router.get('/:id/files', async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const projectRepo = AppDataSource.getRepository(Project);
        const project = await projectRepo.findOne({
            where: { id: req.params.id as string, userId: req.user!.id },
        });
        if (!project) throw new AppError('Project not found', 404);

        const relativePath = (req.query.path as string) || '';
        const files = await FileManagerService.listFiles(project.directoryPath, relativePath);
        res.json(files);
    } catch (error) {
        next(error);
    }
});

// Download file
router.get('/:id/files/download', async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const projectRepo = AppDataSource.getRepository(Project);
        const project = await projectRepo.findOne({
            where: { id: req.params.id as string, userId: req.user!.id },
        });
        if (!project) throw new AppError('Project not found', 404);

        const filePath = req.query.path as string;
        if (!filePath) throw new AppError('File path is required', 400);

        const fullPath = await FileManagerService.getFilePath(project.directoryPath, filePath);
        res.download(fullPath);
    } catch (error) {
        next(error);
    }
});

// Upload file(s)
router.post('/:id/files/upload', upload.array('files', 20), async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const projectRepo = AppDataSource.getRepository(Project);
        const project = await projectRepo.findOne({
            where: { id: req.params.id as string, userId: req.user!.id },
        });
        if (!project) throw new AppError('Project not found', 404);

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

// Delete file
router.delete('/:id/files', async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const projectRepo = AppDataSource.getRepository(Project);
        const project = await projectRepo.findOne({
            where: { id: req.params.id as string, userId: req.user!.id },
        });
        if (!project) throw new AppError('Project not found', 404);

        const filePath = req.query.path as string;
        if (!filePath) throw new AppError('File path is required', 400);

        await FileManagerService.deleteFile(project.directoryPath, filePath);
        res.json({ message: 'File deleted' });
    } catch (error) {
        next(error);
    }
});

// Create directory
router.post('/:id/files/mkdir', async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const projectRepo = AppDataSource.getRepository(Project);
        const project = await projectRepo.findOne({
            where: { id: req.params.id as string, userId: req.user!.id },
        });
        if (!project) throw new AppError('Project not found', 404);

        const { path: dirPath } = req.body;
        if (!dirPath) throw new AppError('Directory path is required', 400);

        await FileManagerService.createDirectory(project.directoryPath, dirPath);
        res.json({ message: 'Directory created' });
    } catch (error) {
        next(error);
    }
});

// Read file content (for editor)
router.get('/:id/files/read', async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const projectRepo = AppDataSource.getRepository(Project);
        const project = await projectRepo.findOne({
            where: { id: req.params.id as string, userId: req.user!.id },
        });
        if (!project) throw new AppError('Project not found', 404);

        const filePath = req.query.path as string;
        if (!filePath) throw new AppError('File path is required', 400);

        const { content, size } = await FileManagerService.readFile(project.directoryPath, filePath);
        res.json({ content, size });
    } catch (error) {
        next(error);
    }
});

// Save file content (from editor)
router.put('/:id/files/write', async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const projectRepo = AppDataSource.getRepository(Project);
        const project = await projectRepo.findOne({
            where: { id: req.params.id as string, userId: req.user!.id },
        });
        if (!project) throw new AppError('Project not found', 404);

        const { path: filePath, content } = req.body;
        if (!filePath) throw new AppError('File path is required', 400);
        if (typeof content !== 'string') throw new AppError('Content must be a string', 400);

        await FileManagerService.writeFile(project.directoryPath, filePath, content);
        res.json({ message: 'File saved' });
    } catch (error) {
        next(error);
    }
});

// Create new file
router.post('/:id/files/create', async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const projectRepo = AppDataSource.getRepository(Project);
        const project = await projectRepo.findOne({
            where: { id: req.params.id as string, userId: req.user!.id },
        });
        if (!project) throw new AppError('Project not found', 404);

        const { path: filePath, content } = req.body;
        if (!filePath) throw new AppError('File path is required', 400);

        await FileManagerService.writeFile(project.directoryPath, filePath, content || '');
        res.json({ message: 'File created' });
    } catch (error) {
        next(error);
    }
});

export default router;

