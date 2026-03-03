import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { config } from '../config';

const UPLOAD_DIR = './storage/uploads';

if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (_req, _file, cb) => {
        // Destination is set locally
        cb(null, UPLOAD_DIR);
    },
    filename: (_req, file, cb) => {
        // Preserve original filename
        cb(null, file.originalname);
    },
});

export const createUploadMiddleware = (maxSizeMB?: number) => {
    const limit = (maxSizeMB || config.hosting.maxUploadSizeMB) * 1024 * 1024;
    return multer({
        storage,
        limits: {
            fileSize: limit,
        },
    });
};

export const upload = createUploadMiddleware();
