'use strict';

/**
 * upload.js — Centralized Multer middleware factory for file uploads.
 *
 * Creates category-specific upload instances that store files to:
 *   /uploads/<category>/<timestamp>-<random>.<ext>
 *
 * Supported categories: avatars, products, categories, payments, deposits, targets, target-apps
 *
 * Usage:
 *   const { createUpload } = require('../../shared/middlewares/upload');
 *   const avatarUpload = createUpload('avatars');
 *   router.patch('/me/avatar', avatarUpload.single('avatar'), handler);
 *
 * Legacy default export (backward-compatible for deposits):
 *   const upload = require('../../shared/middlewares/upload');
 *   router.post('/deposits', upload.single('screenshotProof'), handler);
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { BusinessRuleError } = require('../errors/AppError');

// ── Constants ─────────────────────────────────────────────────────────────────

const UPLOADS_ROOT = path.join(__dirname, '..', '..', '..', 'uploads');

/** Max file size: 20 MB */
const MAX_FILE_SIZE = 20 * 1024 * 1024;

/**
 * Allowed MIME types for image uploads.
 * Deposits additionally allow PDFs (receipts).
 */
const IMAGE_MIME_TYPES = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/svg+xml',
    'image/bmp',
]);

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg', '.bmp']);

/** Deposits also accept PDFs */
const DEPOSIT_MIME_TYPES = new Set([...IMAGE_MIME_TYPES, 'application/pdf']);
const DEPOSIT_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, '.pdf']);

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create a configured multer instance for a specific upload category.
 *
 * @param {'avatars'|'products'|'categories'|'payments'|'deposits'|'targets'|'target-apps'} category
 * @returns {multer.Multer} A multer instance ready to use as middleware
 */
const createUpload = (category) => {
    const uploadDir = path.join(UPLOADS_ROOT, category);

    // Ensure directory exists
    fs.mkdirSync(uploadDir, { recursive: true });

    // Storage: disk with collision-proof filenames
    const storage = multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, uploadDir),
        filename: (_req, file, cb) => {
            const timestamp = Date.now();
            const random = crypto.randomBytes(8).toString('hex');
            const ext = path.extname(file.originalname).toLowerCase();
            cb(null, `${timestamp}-${random}${ext}`);
        },
    });

    // File filter: deposits allow PDFs, everything else is images-only
    const isDeposit = category === 'deposits';
    const allowedMimes = isDeposit ? DEPOSIT_MIME_TYPES : IMAGE_MIME_TYPES;
    const allowedExts = isDeposit ? DEPOSIT_EXTENSIONS : IMAGE_EXTENSIONS;

    const fileFilter = (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const mimeOk = allowedMimes.has(file.mimetype);
        const extOk = allowedExts.has(ext);

        if (!mimeOk || !extOk) {
            const accepted = isDeposit
                ? 'JPG, JPEG, PNG, WebP, GIF, SVG, BMP, and PDF'
                : 'JPG, JPEG, PNG, WebP, GIF, SVG, and BMP';
            return cb(
                new BusinessRuleError(
                    `Only ${accepted} files are accepted.`,
                    'INVALID_FILE_TYPE'
                )
            );
        }
        cb(null, true);
    };

    return multer({
        storage,
        fileFilter,
        limits: {
            fileSize: MAX_FILE_SIZE,
            files: 1,
        },
    });
};

// ── Exports ───────────────────────────────────────────────────────────────────

// Factory for creating category-specific uploaders
module.exports = createUpload('deposits');   // backward-compatible default
module.exports.createUpload = createUpload;
