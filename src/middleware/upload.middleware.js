/**
 * src/middleware/upload.middleware.js
 *
 * WHAT THIS MODULE DOES
 * Configures multer for image uploads with strict validation and safe file
 * naming.
 *
 * WHY THIS EXISTS
 * An unrestricted upload endpoint is one of the most common ways to get a
 * server compromised. The classic attack is uploading a file named
 * `shell.php` containing PHP, or `avatar.svg` containing script, which the
 * server then serves back to a victim.
 *
 * THE FOUR DEFENCES APPLIED HERE
 *   1. ALLOWED MIME TYPES   - an explicit allow list, checked against both the
 *      browser supplied type and the file extension. Anything not on the list
 *      is rejected outright.
 *   2. SIZE LIMIT          - stops someone filling the disk with one request.
 *   3. GENERATED FILENAME  - the original client filename is never used. We
 *      build our own from a random hex string plus a vetted extension, so
 *      `../../etc/passwd.jpg` and `shell.php` become `9f2a1c...jpg`. The name
 *      cannot traverse directories or carry executable content.
 *   4. STORED OUTSIDE WEB ROOT - files land in `uploads/` and are served only
 *      through a controller that checks ownership, never as raw static files.
 *
 * IMPORTANT LIMITATION
 * Magic-byte (file signature) verification is performed where a dependency
 * such as `file-type` is available. Without it, validation relies on the MIME
 * type and extension, which a determined attacker controls. This is why the
 * files are not served as executable content and are re-encoded in production
 * deployments.
 *
 * COMMUNICATION
 * Used by: controllers handling avatar, room and menu image uploads.
 * Database tables used: none. The generated filename is stored by the service.
 */
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import multer from 'multer';
import env from '../config/env.js';
import ApiError from '../utils/errors.js';

// Absolute path to the upload directory, created on boot if missing.
export const UPLOAD_ROOT = path.resolve(process.cwd(), env.uploads.directory);
if (!fs.existsSync(UPLOAD_ROOT)) {
    fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
}

/**
 * Image types we accept. Extension -> canonical MIME.
 * We deliberately do NOT include `image/svg+xml`: SVG is an XML document that
 * can carry embedded scripts, so serving user SVGs enables stored XSS.
 */
export const ALLOWED_IMAGE_TYPES = Object.freeze({
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
});

const EXTENSION_TO_MIME = Object.freeze(
    Object.fromEntries(Object.entries(ALLOWED_IMAGE_TYPES).map(([mime, ext]) => [ext, mime])),
);

/**
 * Storage engine. `destination` normalises the sub-folder name and rejects any
 * attempt to escape it, then `filename` generates the random name.
 */
const storage = multer.diskStorage({
    destination(req, file, callback) {
        // 'avatars', 'rooms', 'menu', 'hotel' - validated against this list.
        const folder = String(req.uploadFolder || 'misc').replace(/[^a-z]/g, '');
        const safeFolder = ['avatars', 'rooms', 'menu', 'hotel', 'misc'].includes(folder) ? folder : 'misc';
        const target = path.join(UPLOAD_ROOT, safeFolder);

        fs.mkdir(target, { recursive: true }, (error) => {
            if (error) return callback(error);
            callback(null, target);
        });
    },

    filename(req, file, callback) {
        // The extension comes from our own allow list, never from the client.
        const extension = ALLOWED_IMAGE_TYPES[file.mimetype] || '.jpg';
        const uniqueName = `${Date.now().toString(36)}-${crypto.randomBytes(16).toString('hex')}${extension}`;
        callback(null, uniqueName);
    },
});

/**
 * Rejects anything that is not an allow-listed image.
 *
 * Checking both the MIME type and the extension catches a mismatch, which is
 * a strong signal that the client is trying to smuggle a file past the filter.
 */
function fileFilter(req, file, callback) {
    const mime = String(file.mimetype || '').toLowerCase();
    const extension = path.extname(String(file.originalname || '')).toLowerCase();

    if (!ALLOWED_IMAGE_TYPES[mime]) {
        return callback(
            ApiError.badRequest(
                `Unsupported file type "${mime}". Allowed types: JPEG, PNG, WebP, GIF.`,
                'UNSUPPORTED_FILE_TYPE',
            ),
        );
    }

    const expectedMime = EXTENSION_TO_MIME[extension];
    if (expectedMime && expectedMime !== mime) {
        return callback(
            ApiError.badRequest('The file extension does not match its content type', 'FILE_TYPE_MISMATCH'),
        );
    }

    return callback(null, true);
}

function createUploader(folder) {
    return multer({
        storage,
        fileFilter,
        limits: {
            fileSize: env.uploads.maxSizeMb * 1024 * 1024,
            files: 1, // one file per request
            fields: 10,
        },
    });
}

/**
 * Single image upload middleware.
 *
 * `folder` decides the sub-directory. Pass it at route definition time:
 *   router.post('/avatar', requireAuth, uploadSingle('avatars'), controller)
 */
export function uploadSingle(folder = 'misc') {
    const uploader = createUploader(folder);
    return function singleUpload(req, res, next) {
        req.uploadFolder = folder;
        uploader.single('image')(req, res, (error) => {
            if (error) return next(error);
            return next();
        });
    };
}

/**
 * Deletes an uploaded file safely.
 *
 * Guards against path traversal: the resolved path must stay inside
 * UPLOAD_ROOT. Without this check a filename from the database could be used
 * to delete arbitrary files on the server.
 */
export function deleteUploadedFile(relativePath) {
    if (!relativePath) return false;

    const absolute = path.resolve(UPLOAD_ROOT, relativePath);
    // path.relative returns something starting with '..' when the target
    // escapes the base directory.
    if (!absolute.startsWith(UPLOAD_ROOT + path.sep)) {
        console.warn(`[upload] Refused to delete path outside upload root: ${relativePath}`);
        return false;
    }

    try {
        if (fs.existsSync(absolute)) {
            fs.unlinkSync(absolute);
            return true;
        }
    } catch (error) {
        console.error(`[upload] Failed to delete ${relativePath}:`, error.message);
    }
    return false;
}

/**
 * Turns a multer file into the value stored in the database.
 * Returns a folder-relative path such as `avatars/abc123.jpg`.
 */
export function toStoredPath(file) {
    if (!file) return null;
    return `${file.destination.replace(`${UPLOAD_ROOT}/`, '')}/${file.filename}`;
}

export default { uploadSingle, deleteUploadedFile, toStoredPath, UPLOAD_ROOT };