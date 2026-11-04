'use strict';

const sharp = require('sharp');

const DEFAULT_ANALYZER_CONFIG = {
    enableOcr: false,
    minEntropy: 1.0,
    blackMeanMax: 8,
    whiteMeanMin: 247,
    solidStdDevMax: 2.5,
    lowEntropyStdDevMax: 3.2,
    maxInputPixels: 40_000_000,
    ocrTimeoutMs: 3500,
    ocrResizeWidth: 1200,
    ocrMinKeywordMatches: 1,
    ocrKeywords: ['تم', 'نجاح', 'فودافون', 'vodafone', 'cash', 'كاش', 'تحويل'],
};

const loadAnalyzerService = ({ config = {}, sharpThrows = false } = {}) => {
    jest.resetModules();
    jest.doMock('../config/config', () => ({
        receiptAnalyzer: { ...DEFAULT_ANALYZER_CONFIG, ...config },
    }));

    if (sharpThrows) {
        jest.doMock('sharp', () => {
            throw new Error('MODULE_NOT_FOUND');
        }, { virtual: true });
    }

    return require('../shared/services/receiptAnalyzer.service');
};

const makeSolidImage = (color) => sharp({
    create: { width: 100, height: 80, channels: 3, background: color },
}).png().toBuffer();

const makeDetailedImage = async () => {
    const width = 120;
    const height = 90;
    const pixels = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const offset = (y * width + x) * 3;
            pixels[offset] = (x * 17 + y * 3) % 256;
            pixels[offset + 1] = (x * 5 + y * 11) % 256;
            pixels[offset + 2] = (x + y * 13) % 256;
        }
    }
    return sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
};

describe('receiptAnalyzer.service', () => {
    afterEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
    });

    it('rejects empty buffers', async () => {
        const service = loadAnalyzerService();
        const result = await service.analyzeReceiptBuffer(Buffer.alloc(0));
        expect(result.isValid).toBe(false);
        expect(result.reason).toBe('EMPTY_OR_INVALID_BUFFER');
    });

    it('rejects solid black images', async () => {
        const service = loadAnalyzerService();
        const result = await service.analyzeReceiptBuffer(await makeSolidImage({ r: 0, g: 0, b: 0 }));
        expect(result.isValid).toBe(false);
        expect(result.reason).toBe('SOLID_BLACK_IMAGE');
    });

    it('rejects solid white images', async () => {
        const service = loadAnalyzerService();
        const result = await service.analyzeReceiptBuffer(await makeSolidImage({ r: 255, g: 255, b: 255 }));
        expect(result.isValid).toBe(false);
        expect(result.reason).toBe('SOLID_WHITE_IMAGE');
    });

    it('rejects low-entropy blank-like images', async () => {
        const service = loadAnalyzerService();
        const result = await service.analyzeReceiptBuffer(await makeSolidImage({ r: 121, g: 121, b: 121 }));
        expect(result.isValid).toBe(false);
        expect(result.reason).toBe('LOW_ENTROPY_IMAGE');
    });

    it('accepts a detailed, decodable image', async () => {
        const service = loadAnalyzerService();
        const result = await service.analyzeReceiptBuffer(await makeDetailedImage());
        expect(result.isValid).toBe(true);
        expect(result.metadata).toEqual({ format: 'png', width: 120, height: 90 });
    });

    it('rejects a non-empty buffer that is not a decodable image', async () => {
        const service = loadAnalyzerService();
        const result = await service.analyzeReceiptBuffer(Buffer.from('not-an-image'));
        expect(result.isValid).toBe(false);
        expect(result.reason).toBe('CORRUPTED_OR_UNSUPPORTED_IMAGE');
    });

    it('marks image invalid when sharp is unavailable', async () => {
        const service = loadAnalyzerService({ sharpThrows: true });
        const result = await service.analyzeReceiptBuffer(Buffer.from('not-an-image'));
        expect(result.isValid).toBe(false);
        expect(result.reason).toBe('SHARP_NOT_AVAILABLE');
    });
});
