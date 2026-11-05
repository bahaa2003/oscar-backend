'use strict';

const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');
const { validateUploadedFileSignature } = require('../middlewares/upload');

// Preserve animated and other legacy formats as they were uploaded.
module.exports = async (file) => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) return file;
    await validateUploadedFileSignature(file);
    const input = await fs.readFile(file.path);
    const metadata = await sharp(input, { animated: true, limitInputPixels: 40_000_000 }).metadata();
    if (metadata.pages > 1) return file;
    const outputPath = `${file.path}.optimized.webp`;
    try {
        const output = await sharp(input, { limitInputPixels: 40_000_000 })
            .rotate()
            .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 80, effort: 4 })
            .toBuffer();
        await fs.writeFile(outputPath, output, { flag: 'wx' });
        await fs.unlink(file.path);
        return { ...file, path: outputPath, filename: path.basename(outputPath), mimetype: 'image/webp', size: output.length };
    } catch (error) {
        await fs.unlink(outputPath).catch(() => {});
        throw error;
    }
};
