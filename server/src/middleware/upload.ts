import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { config } from '../config';

const UPLOAD_DIR = './storage/uploads';

if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (_req, _file, cb) => {
        cb(null, UPLOAD_DIR);
    },
    filename: (_req, file, cb) => {
        // Prefix with UUID to prevent collisions and overwrite attacks
        const uniquePrefix = crypto.randomUUID();
        const safeName = path.basename(file.originalname);
        cb(null, `${uniquePrefix}-${safeName}`);
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
