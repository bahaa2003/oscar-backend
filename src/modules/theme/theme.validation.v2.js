'use strict';

const { ValidationError, AppError } = require('../../shared/errors/AppError');
const FREE_FONTS_AR = ['Cairo', 'Tajawal'];
const PRO_FONTS_AR = ['Noto Sans Arabic', 'Almarai', 'Changa', 'IBM Plex Sans Arabic', 'Rubik'];
const FREE_FONTS_EN = ['Inter', 'Arial'];
const PRO_FONTS_EN = ['Roboto', 'Poppins', 'Montserrat', 'Outfit', 'Plus Jakarta Sans'];
const FREE_PRESETS = ['classic', 'midnight', 'warm'];
const PRO_PRESETS = ['ocean', 'forest', 'royal', 'sunset', 'graphite',
    'gold', 'silver', 'copper', 'ruby', 'orchid', 'aurora', 'desert', 'frost'];
const palettes = {
    classic: { light: ['#2563EB','#475569','#F59E0B','#FFFFFF','#F8FAFC','#0F172A','#475569','#CBD5E1'], dark: ['#60A5FA','#A78BFA','#FBBF24','#0F172A','#1E293B','#F8FAFC','#CBD5E1','#475569'] },
    midnight: { light: ['#1D4ED8','#334155','#D97706','#EFF6FF','#FFFFFF','#0F172A','#475569','#CBD5E1'], dark: ['#60A5FA','#A78BFA','#FBBF24','#0B1023','#17213A','#F8FAFC','#CBD5E1','#475569'] },
    warm: { light: ['#B45309','#92400E','#047857','#FFFBEB','#FFFFFF','#292524','#57534E','#D6D3D1'], dark: ['#FBBF24','#FDBA74','#6EE7B7','#292014','#3C2D1D','#FFF7ED','#D6D3D1','#786550'] },
    ocean: { light: ['#0369A1','#0E7490','#0F766E','#F0F9FF','#FFFFFF','#082F49','#475569','#BAE6FD'], dark: ['#38BDF8','#67E8F9','#5EEAD4','#082F49','#164E63','#F0F9FF','#BAE6FD','#0E7490'] },
    forest: { light: ['#15803D','#166534','#B45309','#F0FDF4','#FFFFFF','#14532D','#3F6212','#BBF7D0'], dark: ['#4ADE80','#86EFAC','#FACC15','#0F2418','#193D27','#F0FDF4','#BBF7D0','#3F6212'] },
    royal: { light: ['#6D28D9','#7C3AED','#C026D3','#FAF5FF','#FFFFFF','#2E1065','#6B21A8','#DDD6FE'], dark: ['#C4B5FD','#A78BFA','#F0ABFC','#1E1239','#322258','#FAF5FF','#DDD6FE','#6D28D9'] },
    sunset: { light: ['#C2410C','#BE123C','#B45309','#FFF7ED','#FFFFFF','#431407','#7C2D12','#FED7AA'], dark: ['#FB923C','#FDA4AF','#FCD34D','#2A1411','#43201A','#FFF7ED','#FED7AA','#9A3412'] },
    graphite: { light: ['#334155','#475569','#0E7490','#F8FAFC','#FFFFFF','#0F172A','#475569','#CBD5E1'], dark: ['#E2E8F0','#94A3B8','#67E8F9','#0F172A','#1E293B','#F8FAFC','#CBD5E1','#475569'] },
    gold: { light: ['#9A6700','#6B4E16','#B45309','#FFFCF2','#FFF4D6','#2C210C','#594B32','#D9C28E'], dark: ['#FACC15','#EAB308','#FDE68A','#1C170B','#302711','#FFF9E6','#CFC29B','#796333'] },
    silver: { light: ['#475569','#64748B','#0E7490','#F8FAFC','#E9EEF3','#111827','#475569','#B9C3CF'], dark: ['#E2E8F0','#94A3B8','#67E8F9','#111827','#1F2937','#F8FAFC','#CBD5E1','#475569'] },
    copper: { light: ['#9A3412','#7C2D12','#B45309','#FFFAF5','#FFF1E6','#31170E','#654838','#D8B6A1'], dark: ['#FDBA74','#FB923C','#FDE68A','#21130F','#38211A','#FFF7ED','#D6B8A7','#895841'] },
    ruby: { light: ['#BE123C','#9F1239','#7C3AED','#FFF7F9','#FFEAF0','#3B0A1B','#6D3349','#F5B8CB'], dark: ['#FDA4AF','#FB7185','#F0ABFC','#210B16','#391322','#FFF1F2','#D8A7B8','#89344C'] },
    orchid: { light: ['#9333EA','#7E22CE','#DB2777','#FDF8FF','#F3E8FF','#2E1065','#6B3A80','#D8B4FE'], dark: ['#E9D5FF','#C084FC','#F9A8D4','#1B1026','#301B43','#FAF5FF','#D8B4E8','#6B3A80'] },
    aurora: { light: ['#0F766E','#0369A1','#7C3AED','#F0FDFA','#FFFFFF','#102A2B','#48615F','#99F6E4'], dark: ['#5EEAD4','#7DD3FC','#C4B5FD','#071F24','#11313A','#F0FDFA','#B7D9D8','#2C6B72'] },
    desert: { light: ['#A16207','#9A3412','#0F766E','#FFFBF3','#FFF4DF','#33220F','#6B5037','#E7CFA7'], dark: ['#FCD34D','#FDBA74','#5EEAD4','#231B12','#392A1B','#FFF7E6','#D7C0A0','#826443'] },
    frost: { light: ['#0E7490','#2563EB','#0891B2','#F3FAFC','#E7F5F9','#102A38','#426171','#B6DCE7'], dark: ['#67E8F9','#93C5FD','#C4B5FD','#0B1825','#152B3B','#F0F9FF','#BDD4E2','#3A6478'] },
};
const colorKeys = ['primary','secondary','accent','background','surface','text','mutedText','border'];
const allowed = {
    typography: { arabicFont: [...FREE_FONTS_AR, ...PRO_FONTS_AR], englishFont: [...FREE_FONTS_EN, ...PRO_FONTS_EN], baseSize: [14,16,18,20], headingWeight: [600,700,800] },
    buttons: { radius: [0,4,8,12,24], style: ['solid','outline'] },
    cards: { radius: [0,4,8,12,16,24], shadow: ['none','subtle','medium'] },
    navigation: { style: ['standard','compact'] },
    freeFonts: { arabic: FREE_FONTS_AR, english: FREE_FONTS_EN }, freePresets: FREE_PRESETS, proPresets: PRO_PRESETS,
};
const baseTypography = { arabicFont: 'Cairo', englishFont: 'Inter', baseSize: 16, headingWeight: 700 };
const baseButtons = { radius: 8, style: 'solid' };
const baseCards = { radius: 12, shadow: 'subtle' };
const baseNavigation = { style: 'standard' };
const DEFAULT_MARQUEE_AR = 'بِسْمِ اللَّهِ الرَّحْمَنِ الرَّحِيمِ ﴿قُلْ إِنَّ رَبِّي يَبْسُطُ الرِّزْقَ لِمَنْ يَشَاءُ مِنْ عِبَادِهِ وَيَقْدِرُ لَهُ وَمَا أَنْفَقْتُمْ مِنْ شَيْءٍ فَهُوَ يُخْلِفُهُ وَهُوَ خَيْرُ الرَّازِقِينَ﴾ صَدَقَ اللَّهُ الْعَظِيمُ';
const neonSections = ['purchase', 'hero', 'categories', 'bestSellers'];
const neonColors = { purchase: '#22D3EE', hero: '#A855F7', categories: '#34D399', bestSellers: '#F59E0B' };
const baseNeon = () => ({ ...Object.fromEntries(neonSections.map((section) =>
    [section, { enabled: false, color: neonColors[section], speed: 5 }])), categoryCards: {} });
const baseChrome = () => ({
    header: { template: 'bar', height: 64, width: 100, background: '#FFFFFF', foreground: '#0F172A', accent: '#2563EB', radius: 0 },
    bottomNav: { template: 'bar', height: 64, width: 100, background: '#FFFFFF', foreground: '#0F172A', accent: '#2563EB', radius: 0 },
});
const baseSidebarMetrics = () => ({ width: 270, height: 100, radius: 28 });
const validateChromePart = (value, path, templateValues, radiusValues, heightRange, widthRange) => {
    keysOnly(value, ['template', 'height', 'width', 'background', 'foreground', 'accent', 'radius'], path);
    if (!templateValues.includes(value.template) || !Number.isInteger(value.height)
        || value.height < heightRange[0] || value.height > heightRange[1]
        || !Number.isInteger(value.width) || value.width < widthRange[0] || value.width > widthRange[1]
        || !radiusValues.includes(value.radius)) invalid(path);
    for (const key of ['background', 'foreground', 'accent']) {
        if (typeof value[key] !== 'string' || !/^#[0-9a-f]{6}$/i.test(value[key])) invalid(`${path}.${key}`);
    }
    if (contrast(value.foreground.toUpperCase(), value.background.toUpperCase()) < 4.5
        || contrast(value.accent.toUpperCase(), value.background.toUpperCase()) < 2.2) invalid(`${path}.contrast`);
    return { template: value.template, height: value.height, width: value.width,
        background: value.background.toUpperCase(), foreground: value.foreground.toUpperCase(),
        accent: value.accent.toUpperCase(), radius: value.radius };
};
const mediaPath = /^\/uploads\/themes\/[0-9]+-[0-9a-f]{16}\.(?:jpe?g|png|webp)$/i;
const invalid = (field) => { throw new ValidationError(`Invalid theme property: ${field}`); };
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const keysOnly = (value, keys, path) => { if (!plain(value)) invalid(path); for (const key of Object.keys(value)) if (!keys.includes(key)) invalid(`${path}.${key}`); };
const luminance = (hex) => [1,3,5].map((start) => parseInt(hex.slice(start,start+2),16)/255)
    .map((x) => x <= 0.04045 ? x/12.92 : ((x+0.055)/1.055)**2.4)
    .reduce((sum,x,i) => sum + x*[0.2126,0.7152,0.0722][i],0);
const contrast = (a,b) => (Math.max(luminance(a),luminance(b))+0.05)/(Math.min(luminance(a),luminance(b))+0.05);
const appearance = (id, mode) => ({ presetId: id, colors: Object.fromEntries(colorKeys.map((key,i) => [key,palettes[id][mode][i]])),
    typography: { ...baseTypography }, buttons: { ...baseButtons }, cards: { ...baseCards }, navigation: { ...baseNavigation }, neon: baseNeon() });

function validateAppearance(value, path) {
    keysOnly(value, ['presetId','colors','typography','buttons','cards','navigation','neon'], path);
    if (!Object.hasOwn(palettes,value.presetId)) invalid(`${path}.presetId`);
    keysOnly(value.colors,colorKeys,`${path}.colors`);
    const colors = {};
    for (const key of colorKeys) {
        if (typeof value.colors[key] !== 'string' || !/^#[0-9a-f]{6}$/i.test(value.colors[key])) invalid(`${path}.colors.${key}`);
        colors[key] = value.colors[key].toUpperCase();
    }
    if (contrast(colors.text,colors.background)<4.5 || contrast(colors.text,colors.surface)<4.5
        || contrast(colors.mutedText,colors.background)<4.5) invalid(`${path}.colors.contrast`);
    const result = { presetId: value.presetId, colors };
    for (const section of ['typography','buttons','cards','navigation']) {
        keysOnly(value[section],Object.keys(allowed[section]),`${path}.${section}`);
        result[section] = {};
        for (const [key,values] of Object.entries(allowed[section])) {
            if (!values.includes(value[section][key])) invalid(`${path}.${section}.${key}`);
            result[section][key] = value[section][key];
        }
    }
    const neon = value.neon === undefined ? baseNeon() : value.neon;
    keysOnly(neon, [...neonSections, 'categoryCards'], `${path}.neon`);
    result.neon = {};
    for (const section of neonSections) {
        const effect = neon[section];
        keysOnly(effect, ['enabled','color','speed'], `${path}.neon.${section}`);
        if (typeof effect.enabled !== 'boolean' || typeof effect.color !== 'string'
            || !/^#[0-9a-f]{6}$/i.test(effect.color) || ![3,5,8,12].includes(effect.speed)) {
            invalid(`${path}.neon.${section}`);
        }
        result.neon[section] = { enabled: effect.enabled, color: effect.color.toUpperCase(), speed: effect.speed };
    }
    const categoryCards = neon.categoryCards === undefined ? {} : neon.categoryCards;
    if (!plain(categoryCards) || Object.keys(categoryCards).length > 100) invalid(`${path}.neon.categoryCards`);
    result.neon.categoryCards = {};
    for (const [categoryId, effect] of Object.entries(categoryCards)) {
        if (!/^[a-zA-Z0-9_-]{1,80}$/.test(categoryId)
            || ['__proto__', 'constructor', 'prototype'].includes(categoryId)) invalid(`${path}.neon.categoryCards.${categoryId}`);
        keysOnly(effect, ['enabled', 'color', 'speed'], `${path}.neon.categoryCards.${categoryId}`);
        if (typeof effect.enabled !== 'boolean' || typeof effect.color !== 'string'
            || !/^#[0-9a-f]{6}$/i.test(effect.color) || ![3, 5, 8, 12].includes(effect.speed)) {
            invalid(`${path}.neon.categoryCards.${categoryId}`);
        }
        result.neon.categoryCards[categoryId] = { enabled: effect.enabled, color: effect.color.toUpperCase(), speed: effect.speed };
    }
    return result;
}

function validateTheme(value) {
    keysOnly(value,['schemaVersion','modes','brand','chrome'],'theme');
    if (value.schemaVersion !== 2) invalid('schemaVersion');
    keysOnly(value.modes,['light','dark'],'modes');
    const modes = { light: validateAppearance(value.modes.light,'modes.light'), dark: validateAppearance(value.modes.dark,'modes.dark') };
    keysOnly(value.brand,['logoPath','logoWidth','slides','marqueeTextArabic','targetBannerPath','sidebarTemplate','sidebarMetrics'],'brand');
    const { logoPath,logoWidth,slides } = value.brand;
    const targetBannerPath = value.brand.targetBannerPath === undefined ? null : value.brand.targetBannerPath;
    const marqueeTextArabic = value.brand.marqueeTextArabic === undefined
        ? DEFAULT_MARQUEE_AR : value.brand.marqueeTextArabic;
    const sidebarTemplate = value.brand.sidebarTemplate === undefined ? 'default' : value.brand.sidebarTemplate;
    const inputSidebarMetrics = value.brand.sidebarMetrics === undefined ? baseSidebarMetrics() : value.brand.sidebarMetrics;
    keysOnly(inputSidebarMetrics, ['width', 'height', 'radius'], 'brand.sidebarMetrics');
    const sidebarMetrics = {
        width: inputSidebarMetrics.width,
        height: inputSidebarMetrics.height,
        radius: inputSidebarMetrics.radius,
    };
    if (!Number.isInteger(sidebarMetrics.width) || sidebarMetrics.width < 220 || sidebarMetrics.width > 360
        || !Number.isInteger(sidebarMetrics.height) || sidebarMetrics.height < 70 || sidebarMetrics.height > 100
        || ![0,4,8,12,16,20,24,28,32,36,40,44,48].includes(sidebarMetrics.radius)) invalid('brand.sidebarMetrics');
    const inputChrome = value.chrome === undefined ? baseChrome() : value.chrome;
    keysOnly(inputChrome, ['header', 'bottomNav'], 'chrome');
    const chrome = {
        header: validateChromePart(inputChrome.header, 'chrome.header', ['bar', 'floating'], [0, 4, 8, 12, 16, 24, 32], [48, 120], [60, 100]),
        bottomNav: validateChromePart(inputChrome.bottomNav, 'chrome.bottomNav', ['bar', 'floating', 'pill'], [0, 4, 8, 12, 16, 24, 32], [48, 100], [60, 100]),
    };
    if (logoPath !== null && (typeof logoPath !== 'string' || !mediaPath.test(logoPath))) invalid('brand.logoPath');
    if (!Number.isInteger(logoWidth) || logoWidth<80 || logoWidth>300) invalid('brand.logoWidth');
    if (!Array.isArray(slides) || slides.length !== 4 || slides.some((slide) => slide !== null
        && (typeof slide !== 'string' || !mediaPath.test(slide)))) invalid('brand.slides');
    if (targetBannerPath !== null && (typeof targetBannerPath !== 'string' || !mediaPath.test(targetBannerPath))) invalid('brand.targetBannerPath');
    if (typeof marqueeTextArabic !== 'string' || marqueeTextArabic !== marqueeTextArabic.trim()
        || marqueeTextArabic.length < 1 || marqueeTextArabic.length > 240
        || !/[\u0600-\u06FF]/u.test(marqueeTextArabic)
        || /[<>\u0000-\u001F\u007F]/u.test(marqueeTextArabic)) invalid('brand.marqueeTextArabic');
    if (!['default', 'royal', 'glass', 'aurora', 'square', 'rounded'].includes(sidebarTemplate)) invalid('brand.sidebarTemplate');
    return { schemaVersion: 2, modes, brand: { logoPath, logoWidth, slides: [...slides], marqueeTextArabic,
        targetBannerPath, sidebarTemplate, sidebarMetrics }, chrome };
}

function preset(id) {
    if (!Object.hasOwn(palettes,id)) invalid('presetId');
    return validateTheme({ schemaVersion: 2, modes: { light: appearance(id,'light'), dark: appearance(id,'dark') },
        brand: { logoPath: null, logoWidth: 144, slides: [null,null,null,null], targetBannerPath: null } });
}

function safeTheme(value) {
    try {
        if (value?.schemaVersion === 1) {
            const copy = preset('classic');
            const legacy = { presetId: value.presetId, colors: value.colors, typography: value.typography,
                buttons: value.buttons, cards: value.cards, navigation: value.navigation };
            copy.modes[value.mode === 'dark' ? 'dark' : 'light'] = validateAppearance(legacy,'legacy');
            return validateTheme(copy);
        }
        return validateTheme(value);
    } catch (_error) { return preset('classic'); }
}

function assertPlanAllows(theme, plan = 'FREE') {
    if (plan === 'THEME_ULTRA') return;
    const defaultChrome = baseChrome();
    if (JSON.stringify(theme.chrome) !== JSON.stringify(defaultChrome)) {
        throw new AppError('Header and bottom navigation customization requires Theme Customization Ultra.', 403, 'THEME_ULTRA_REQUIRED');
    }
    if (plan !== 'THEME_PRO') {
        for (const part of Object.values(theme.modes)) {
            const t = part.typography;
            if (!FREE_PRESETS.includes(part.presetId) || !FREE_FONTS_AR.includes(t.arabicFont)
                || !FREE_FONTS_EN.includes(t.englishFont) || t.baseSize !== 16 || t.headingWeight !== 700
                || JSON.stringify(part.buttons) !== JSON.stringify(baseButtons)
                || JSON.stringify(part.cards) !== JSON.stringify(baseCards)
                || JSON.stringify(part.navigation) !== JSON.stringify(baseNavigation)
                || JSON.stringify(part.neon) !== JSON.stringify(baseNeon())) {
                throw new AppError('This appearance requires Theme Customization Pro.',403,'THEME_PRO_REQUIRED');
            }
        }
        if (theme.brand.logoPath || theme.brand.logoWidth !== 144 || theme.brand.slides.some(Boolean) || theme.brand.targetBannerPath
            || theme.brand.marqueeTextArabic !== DEFAULT_MARQUEE_AR) {
            throw new AppError('Brand and animated text changes require Theme Customization Pro.',403,'THEME_PRO_REQUIRED');
        }
    }
    if (theme.brand.sidebarTemplate !== 'default'
        || JSON.stringify(theme.brand.sidebarMetrics) !== JSON.stringify(baseSidebarMetrics())) {
        throw new AppError('Sidebar templates and dimensions require Theme Customization Ultra.', 403, 'THEME_ULTRA_REQUIRED');
    }
}

module.exports = { validateTheme,safeTheme,preset,allowed,assertPlanAllows,FREE_PRESETS,PRO_PRESETS,DEFAULT_MARQUEE_AR };
