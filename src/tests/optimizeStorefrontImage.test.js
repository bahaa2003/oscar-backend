'use strict';

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const optimize = require('../shared/services/optimizeStorefrontImage');

test('converts a large uploaded PNG to a bounded WebP and removes the original', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oscar-image-'));
    try {
        const original = path.join(dir, 'upload.png');
        await fs.writeFile(original, await sharp({ create: { width: 2400, height: 1200, channels: 4, background: '#6249bb' } }).png().toBuffer());
        const result = await optimize({ path: original, filename: 'upload.png', mimetype: 'image/png' });
        const metadata = await sharp(await fs.readFile(result.path)).metadata();
        expect(metadata.format).toBe('webp');
        expect(metadata.width).toBe(1600);
        expect(metadata.height).toBe(800);
        await expect(fs.stat(original)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('rejects a file whose contents do not match its declared image type', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oscar-image-'));
    try {
        const original = path.join(dir, 'bad.png');
        await fs.writeFile(original, 'not an image');
        await expect(optimize({ path: original, filename: 'bad.png', mimetype: 'image/png' })).rejects.toBeTruthy();
        expect(await fs.readdir(dir)).toEqual(['bad.png']);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});
