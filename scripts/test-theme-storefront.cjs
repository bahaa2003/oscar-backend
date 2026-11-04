'use strict';

// Real browser + real HTTP + temporary MongoDB. No production URI or .env changes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const puppeteer = require('puppeteer');
const frontend = path.resolve(process.argv[2] || path.join(__dirname, '../../oscar frontend'));
const chrome = [process.env.CHROME_BIN, puppeteer.executablePath(),
    'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium', '/usr/bin/google-chrome']
    .find((candidate) => candidate && fs.existsSync(candidate));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let mongo, browser, httpServer, vite, mongoose;
let uploadedFixture;
let viteLog = '';
const results = [];
const pass = (name) => { results.push(name); console.log(`PASS ${name}`); };

async function freePort() {
    const socket = net.createServer();
    socket.listen(0, '127.0.0.1');
    await once(socket, 'listening');
    const port = socket.address().port;
    await new Promise((resolve) => socket.close(resolve));
    return port;
}

async function clickText(page, text, scope = 'button') {
    await page.waitForFunction((label, selector) => [...document.querySelectorAll(selector)].some((el) => el.textContent.trim() === label && !el.disabled), {}, text, scope);
    await page.evaluate((label, selector) => [...document.querySelectorAll(selector)].find((el) => el.textContent.trim() === label).click(), text, scope);
}

async function columns(page, selector, count) {
    await page.waitForFunction((query, expected) => {
        const element = document.querySelector(query);
        return element && getComputedStyle(element).gridTemplateColumns.split(' ').length === expected;
    }, { timeout: 15000, polling: 100 }, selector, count);
}

async function main() {
    assert(chrome, 'Chrome/Chromium is required; set CHROME_BIN to its executable.');
    assert(fs.existsSync(path.join(frontend, 'src/pages/admin/PlatformThemeEditor.jsx')), 'Pass the OSCAR frontend directory as the first argument.');
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    Object.assign(process.env, { NODE_ENV: 'test', MONGO_URI: mongo.getUri('theme_browser_audit'),
        MONGO_TEST_URI: mongo.getUri('theme_browser_audit'), JWT_SECRET: 'theme-browser-test-only', BCRYPT_ROUNDS: '1' });
    const helpers = require('../src/tests/testHelpers');
    await helpers.connectTestDB();
    mongoose = require('mongoose');
    const theme = require('../src/modules/theme/theme.service');
    const { preset } = require('../src/modules/theme/theme.validation');
    const { ThemePayment, ThemeSubscription } = require('../src/modules/theme/subscription.model');
    const { Category } = require('../src/modules/categories/category.model');
    const { Currency } = require('../src/modules/currency/currency.model');
    const jwt = require('jsonwebtoken');
    const admin = await helpers.createAdmin({ phone: '+201000000001', profileCompletedAt: new Date() });
    const customer = (await helpers.createCustomerWithGroup({ phone: '+201000000002', profileCompletedAt: new Date() })).customer;
    await Currency.create({ code: 'USD', name: 'Test US dollar', symbol: '$', platformRate: 1, isActive: true });
    const startsAt = new Date(Date.now() - 1000);
    const payment = await ThemePayment.create({ scopeKey: 'main', payerUserId: admin._id, provider: 'TEST',
        providerReference: 'ISOLATED-THEME-BROWSER', planId: 'THEME_ULTRA', amountMinor: 2999, currency: 'USDT',
        status: 'VERIFIED', verifiedAt: new Date(startsAt.getTime() - 1000) });
    await ThemeSubscription.create({ scopeKey: 'main', payerUserId: admin._id, planId: 'THEME_ULTRA',
        amountMinor: 2999, currency: 'USDT', status: 'ACTIVE', verifiedPaymentId: payment._id,
        startsAt, expiresAt: theme.addCalendarMonthsUTC(startsAt, 3) });
    for (let category = 1; category <= 6; category++) {
        const record = await Category.create({ name: `Audit Section ${category}`, nameAr: `قسم اختبار ${category}`, sortOrder: category });
        for (let product = 1; product <= 6; product++) {
            await helpers.createProduct({ name: `Audit Product ${category}-${product}`, category: record._id.toString(), displayOrder: product });
        }
    }
    const initial = preset('classic');
    initial.layout = { productsPerRow: 4, categoriesPerRow: 2 };
    await theme.publish(admin._id, initial);
    httpServer = require('../src/app').listen(0, '127.0.0.1');
    await once(httpServer, 'listening');
    const apiOrigin = `http://127.0.0.1:${httpServer.address().port}`;
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    vite = spawn(process.execPath, [path.join(frontend, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
        cwd: frontend, windowsHide: true, env: { ...process.env, VITE_API_BASE_URL: `${apiOrigin}/api`,
            VITE_DATA_PROVIDER: 'real', DISABLE_HMR: 'true' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    vite.stdout.on('data', (chunk) => { viteLog += chunk; });
    vite.stderr.on('data', (chunk) => { viteLog += chunk; });
    for (let attempt = 0; attempt < 100; attempt++) {
        try { if ((await fetch(origin)).ok) break; } catch (_) { /* wait for local Vite */ }
        if (attempt === 99) throw new Error(`Vite failed to start: ${viteLog}`);
        await delay(150);
    }
    browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
    const contexts = [];
    const makePage = async (user = null, sharedContext = null) => {
        const context = sharedContext || await browser.createBrowserContext(); contexts.push(context);
        const page = await context.newPage();
        await page.setViewport({ width: 1440, height: 1000 });
        await page.setRequestInterception(true);
        page.on('request', async (req) => {
            const url = req.url();
            if (page.deferThemeRead && req.method() === 'GET' && url.endsWith('/theme/published')) {
                page.deferThemeRead = false;
                const previous = await fetch(url).then((response) => response.text());
                page.releaseThemeRead = () => req.respond({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: previous });
                page.onThemeReadDeferred?.();
                return;
            }
            if (page.failThemeReads && url.endsWith('/theme/published')) return req.respond({ status: 503, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: '{"success":false}' });
            const publicFont = page.allowFontRequests && /^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(url);
            if (url.startsWith('http') && !url.startsWith(origin) && !url.startsWith(apiOrigin) && !publicFont) return req.abort();
            return req.continue();
        });
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        page.testErrors = errors;
        await page.evaluateOnNewDocument((auth) => {
            localStorage.setItem('i18nextLng', 'ar');
            if (!localStorage.getItem('oscar-theme')) localStorage.setItem('oscar-theme', 'light');
            localStorage.setItem('oscar-store-service-notice-seen-v1', '1');
            if (auth) localStorage.setItem('auth-storage', JSON.stringify({ state: auth }));
        }, user ? { token: jwt.sign({ id: user._id.toString(), role: user.role }, process.env.JWT_SECRET),
            user: { id: user._id.toString(), role: user.role.toLowerCase(), status: 'ACTIVE', verified: true, phone: user.phone, name: user.name } } : null);
        return page;
    };
    const adminPage = await makePage(admin);
    await adminPage.goto(`${origin}/admin/themes#studio-layout`, { waitUntil: 'networkidle2' });
    await adminPage.waitForSelector('[data-theme-publish]');
    await clickText(adminPage, '3 منتجات');
    await clickText(adminPage, '3 أقسام');
    assert.deepEqual((await theme.published()).published.layout, initial.layout, 'Draft selection must not leak into published settings.');
    const frameElement = await adminPage.waitForSelector('iframe');
    const frame = await frameElement.contentFrame();
    await frame.waitForSelector('.storefront-category-card');
    await columns(frame, '.platform-theme-category-grid', 3);
    await frame.click('.storefront-category-card');
    await frame.waitForSelector('.storefront-product-card');
    await columns(frame, '.platform-theme-product-grid', 3);
    await clickText(adminPage, 'موبايل', '.storefront-theme-preview__devices button');
    await frame.waitForSelector('.platform-bottom-nav');
    await columns(frame, '.platform-theme-product-grid', 2);
    assert.equal(await frame.$eval('.platform-bottom-nav', (element) => getComputedStyle(element).display), 'grid');
    await clickText(adminPage, 'كمبيوتر', '.storefront-theme-preview__devices button');
    await columns(frame, '.platform-theme-product-grid', 3);
    pass('Authenticated real-storefront preview renders the draft; published values remain unchanged');

    const sibling = await makePage(admin, adminPage.browserContext());
    await sibling.goto(`${origin}/dashboard`, { waitUntil: 'networkidle2' });
    await columns(sibling, '.platform-theme-category-grid', 2);
    const deferredRead = new Promise((resolve) => { sibling.onThemeReadDeferred = resolve; });
    sibling.deferThemeRead = true;
    await sibling.evaluate(() => window.dispatchEvent(new Event('platform-theme-subscription-updated')));
    let deferredTimer;
    try {
        await Promise.race([deferredRead, new Promise((_, reject) => { deferredTimer = setTimeout(() => reject(new Error('The expected local theme read did not start.')), 15000); })]);
    } finally { clearTimeout(deferredTimer); }

    let publishRequests = 0, saveRequests = 0;
    adminPage.on('request', (req) => {
        if (req.method() === 'POST' && req.url().endsWith('/admin/theme/publish')) publishRequests++;
        if (req.method() === 'POST' && req.url().endsWith('/admin/theme/draft')) saveRequests++;
    });
    const publish = async () => {
        const previous = (await theme.published()).version;
        await adminPage.bringToFront();
        await adminPage.click('[data-theme-publish]');
        await adminPage.waitForSelector('[role="dialog"]');
        await adminPage.evaluate(() => {
            const confirm = [...document.querySelectorAll('[role="dialog"] button')].find((el) => el.textContent.trim() === 'تأكيد');
            confirm.click(); confirm.click();
        });
        await adminPage.waitForFunction((version, url) => fetch(`${url}/api/theme/published`).then((r) => r.json()).then((r) => r.data.version > version), {}, previous, apiOrigin);
        await adminPage.waitForFunction(() => !document.querySelector('[data-theme-publish]').disabled);
    };
    await publish();
    assert.equal(publishRequests, 1); assert.equal(saveRequests, 1);
    assert.deepEqual((await theme.published()).published.layout, { productsPerRow: 3, categoriesPerRow: 3 });
    await sibling.releaseThemeRead();
    await columns(sibling, '.platform-theme-category-grid', 3);
    pass('An already-open same-origin tab refreshes after broadcast and discards a delayed pre-publish response');
    await adminPage.waitForFunction(() => document.documentElement.style.getPropertyValue('--platform-products-desktop') === '3');
    assert.equal(await adminPage.$$eval('[data-theme-publish]', (buttons) => buttons.length), 1);
    pass('One publish control and one save + one publish request, including rapid repeated confirmation');

    const visitor = await makePage();
    const openProducts = async (page, refresh = false) => {
        if (refresh) await page.reload({ waitUntil: 'networkidle2' });
        else await page.goto(origin, { waitUntil: 'networkidle2' });
        await page.waitForSelector('.storefront-category-card');
        await columns(page, '.platform-theme-category-grid', 3);
        await page.click('.storefront-category-card');
        await page.waitForSelector('.storefront-product-card');
    };
    await openProducts(visitor);
    await columns(visitor, '.platform-theme-product-grid', 3);
    await openProducts(visitor, true);
    await columns(visitor, '.platform-theme-product-grid', 3);
    await visitor.setViewport({ width: 800, height: 1000 });
    await columns(visitor, '.platform-theme-product-grid', 3);
    await visitor.setViewport({ width: 390, height: 844 });
    await columns(visitor, '.platform-theme-product-grid', 2);
    pass('Incognito, refresh, desktop 3 / tablet 3 / mobile 2 columns and 3 desktop categories');

    await clickText(adminPage, '4 منتجات');
    await publish();
    assert.equal(publishRequests, 2);
    await visitor.setViewport({ width: 1440, height: 1000 });
    await visitor.evaluate(() => window.dispatchEvent(new Event('focus')));
    await columns(visitor, '.platform-theme-product-grid', 4);
    const freshVisitor = await makePage();
    await openProducts(freshVisitor);
    await columns(freshVisitor, '.platform-theme-product-grid', 4);
    pass('Publishing 4 products replaces 3 in an existing focused visitor and a new incognito window');
    visitor.failThemeReads = true;
    const failedRead = visitor.waitForResponse((response) => response.url().endsWith('/theme/published') && response.status() === 503);
    await visitor.evaluate(() => window.dispatchEvent(new Event('focus')));
    await failedRead;
    await columns(visitor, '.platform-theme-product-grid', 4);
    visitor.failThemeReads = false;
    pass('A temporary published-theme read failure preserves the last confirmed public layout');
    for (const count of [5, 6]) {
        await clickText(adminPage, `${count} منتجات`);
        await publish();
        await visitor.evaluate(() => window.dispatchEvent(new Event('focus')));
        await columns(visitor, '.platform-theme-product-grid', count);
    }
    pass('Desktop 5 and 6 product choices render exactly 5 and 6 columns');

    await clickText(adminPage, 'سجل النشر', '.platform-studio__nav button');
    await adminPage.waitForSelector('#theme-history button');
    assert.equal(await adminPage.$$eval('[data-theme-publish]', (buttons) => buttons.length), 1);
    await adminPage.evaluate(() => [...document.querySelectorAll('#theme-history button')].at(-1).click());
    await adminPage.waitForFunction(() => document.body.textContent.includes('تم تحميل الإصدار #1'));
    const beforeHistoryPublish = publishRequests;
    await publish();
    assert.equal(publishRequests, beforeHistoryPublish + 1);
    assert.deepEqual((await theme.published()).published.layout, initial.layout);
    pass('History loads the selected version into the shared draft; the sole publish control publishes that version');

    // Inject errors only in the browser transport; real DB and successful flows above use real HTTP.
    const versionBeforeFailure = (await theme.published()).version;
    await adminPage.waitForFunction(() => document.querySelectorAll('[data-toast-type="success"]').length === 0);
    let failPath = '/admin/theme/publish', falseSuccess = false;
    const interceptor = async (req) => {
        if (req.isInterceptResolutionHandled()) return;
        if (req.url().startsWith('http') && !req.url().startsWith(origin) && !req.url().startsWith(apiOrigin)) return req.abort();
        if (req.method() === 'POST' && req.url().endsWith(failPath)) return req.respond({
            status: falseSuccess ? 200 : 503, contentType: 'application/json',
            headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ success: false, message: 'Injected theme failure' }),
        });
        return req.continue();
    };
    adminPage.removeAllListeners('request');
    adminPage.on('request', interceptor);
    for (const failure of [{ path: '/admin/theme/publish', envelope: false }, { path: '/admin/theme/publish', envelope: true }, { path: '/admin/theme/draft', envelope: false }]) {
        failPath = failure.path; falseSuccess = failure.envelope;
        await adminPage.click('[data-theme-publish]');
        await clickText(adminPage, 'تأكيد', '[role="dialog"] button');
        await adminPage.waitForFunction(() => !document.querySelector('[data-theme-publish]').disabled);
        assert.equal((await theme.published()).version, versionBeforeFailure);
        assert.equal(await adminPage.$$eval('[data-toast-type="success"]', (items) => items.length), 0);
    }
    assert(await adminPage.$('[data-toast-type="error"]'), 'The failure must be visible to the administrator.');
    pass('Failed save, failed publish and HTTP-200 success:false never advance the published version');

    const image = await require('sharp')({ create: { width: 256, height: 128, channels: 3, background: '#123456' } }).png().toBuffer();
    const form = new FormData(); form.append('image', new Blob([image], { type: 'image/png' }), 'theme-browser-fixture.png');
    const uploadResponse = await fetch(`${apiOrigin}/api/admin/theme/media/upload`, { method: 'POST',
        headers: { Authorization: `Bearer ${jwt.sign({ id: admin._id.toString(), role: admin.role }, process.env.JWT_SECRET)}` }, body: form });
    const uploaded = await uploadResponse.json();
    if (uploaded.data?.path) uploadedFixture = path.join(__dirname, '..', uploaded.data.path);
    assert.equal(uploadResponse.status, 200, JSON.stringify(uploaded));
    const styled = preset('classic');
    styled.layout = { productsPerRow: 3, categoriesPerRow: 3 };
    styled.modes.light.colors = { ...styled.modes.light.colors, primary: '#1D4ED8', text: '#172554', surface: '#EFF6FF' };
    Object.assign(styled.modes.light.typography, { arabicFont: 'Tajawal', englishFont: 'Arial', baseSize: 18, headingWeight: 800 });
    styled.modes.light.cards = { radius: 24, shadow: 'medium' };
    styled.modes.light.buttons = { radius: 24, style: 'outline' };
    styled.modes.light.navigation.style = 'compact';
    for (const effect of Object.values(styled.modes.light.neon)) {
        if (typeof effect.enabled === 'boolean') Object.assign(effect, { enabled: true, color: '#F59E0B', speed: 8 });
    }
    styled.brand = { ...styled.brand, logoPath: uploaded.data.path, slides: [uploaded.data.path, null, null, null],
        targetBannerPath: uploaded.data.path, logoWidth: 200, marqueeTextArabic: 'رسالة اختبار الثيم المنشور',
        sidebarTemplate: 'royal', sidebarMetrics: { width: 300, height: 90, radius: 40 } };
    styled.chrome.modes.light.header = { template: 'bar', height: 88, width: 92, background: '#1D4ED8', foreground: '#FFFFFF', accent: '#F59E0B', radius: 12 };
    styled.chrome.modes.light.bottomNav = { template: 'pill', height: 80, width: 88, background: '#114488', foreground: '#FFFFFF', accent: '#F59E0B', radius: 24 };
    styled.chrome.header = styled.chrome.modes.light.header; styled.chrome.bottomNav = styled.chrome.modes.light.bottomNav;
    await theme.publish(admin._id, styled);
    const styledVisitor = await makePage();
    styledVisitor.allowFontRequests = true;
    await styledVisitor.goto(origin, { waitUntil: 'networkidle2' });
    await styledVisitor.waitForSelector('.storefront-category-card');
    const computed = await styledVisitor.evaluate(() => {
        const card = document.querySelector('.storefront-category-card');
        const header = document.querySelector('.app-shell-header-panel');
        const panel = document.querySelector('.app-shell-sidebar-panel');
        const style = getComputedStyle(card);
        return { radius: style.borderTopLeftRadius, shadow: style.boxShadow, surface: style.backgroundColor,
            text: getComputedStyle(card.querySelector('h3')).color, weight: getComputedStyle(card.querySelector('h3')).fontWeight,
            font: getComputedStyle(document.body).fontFamily, size: getComputedStyle(document.documentElement).fontSize,
            headerHeight: header.getBoundingClientRect().height, headerWidth: header.style.width,
            headerBackground: getComputedStyle(header).backgroundColor, headerInline: header.style.cssText,
            headerVariable: getComputedStyle(document.documentElement).getPropertyValue('--platform-header-background'),
            sidebarRadius: getComputedStyle(panel).borderTopLeftRadius,
            sidebarWidth: panel.parentElement.getBoundingClientRect().width,
            categoryNeon: getComputedStyle(card, '::before').animationName,
            heroNeon: getComputedStyle(document.querySelector('[data-platform-neon="true"]'), '::before').animationName };
    });
    assert.equal(computed.radius, '24px'); assert.notEqual(computed.shadow, 'none');
    assert.equal(computed.surface, 'rgb(239, 246, 255)'); assert.equal(computed.text, 'rgb(23, 37, 84)');
    assert.equal(computed.weight, '800'); assert(computed.font.includes('Tajawal')); assert.equal(computed.size, '18px');
    assert(await styledVisitor.$('#oscar-theme-font-tajawal'));
    assert(await styledVisitor.evaluate(async () => {
        const faces = await document.fonts.load('18px Tajawal', 'اختبار الخط');
        return faces.length > 0 && faces.every((face) => face.status === 'loaded');
    }), 'The selected web font must actually download, not only appear in font-family.');
    assert.equal(computed.headerHeight, 88); assert.equal(computed.headerWidth, '92%'); assert.equal(computed.headerBackground, 'rgb(29, 78, 216)', JSON.stringify(computed));
    assert.equal(computed.sidebarRadius, '40px'); assert.equal(computed.sidebarWidth, 300);
    assert.equal(computed.categoryNeon, 'platform-neon-rotate'); assert.equal(computed.heroNeon, 'platform-neon-rotate');
    await styledVisitor.waitForFunction((media) => [...document.images].some((img) => img.src.includes(media) && img.naturalWidth === 256), {}, uploaded.data.path);
    assert((await styledVisitor.content()).includes('رسالة اختبار الثيم المنشور'));
    pass('Real uploaded logo/slider, marquee, fonts, text size/weight, card color/radius/shadow, header dimensions/colors, sidebar dimensions and hero/category neon');

    const customerPage = await makePage(customer);
    await customerPage.goto(`${origin}/dashboard`, { waitUntil: 'networkidle2' });
    await customerPage.waitForSelector('.storefront-category-card');
    await customerPage.waitForFunction((media) => document.querySelector('a[href="/buy-target"] img')?.src.includes(media), {}, uploaded.data.path);
    await columns(customerPage, '.platform-theme-category-grid', 3);
    await customerPage.click('.storefront-category-card');
    await customerPage.waitForSelector('.products-page .storefront-product-card');
    await columns(customerPage, '.platform-theme-product-grid', 3);
    const productStyle = await customerPage.$eval('.storefront-product-card', (el) => ({ radius: getComputedStyle(el).borderTopLeftRadius, shadow: getComputedStyle(el).boxShadow, surface: getComputedStyle(el).backgroundColor }));
    assert.equal(productStyle.radius, '24px'); assert.notEqual(productStyle.shadow, 'none'); assert.equal(productStyle.surface, 'rgb(239, 246, 255)');
    await customerPage.waitForFunction(() => getComputedStyle(document.querySelector('.platform-theme-product-grid'), '::before').animationName === 'platform-neon-rotate');
    await customerPage.setViewport({ width: 390, height: 844 });
    await customerPage.waitForSelector('.platform-bottom-nav');
    const navigation = await customerPage.$eval('.platform-bottom-nav', (el) => ({ height: el.getBoundingClientRect().height, background: getComputedStyle(el).backgroundColor, radius: getComputedStyle(el).borderTopLeftRadius }));
    assert.equal(navigation.height, 80); assert.equal(navigation.background, 'rgb(17, 68, 136)'); assert.equal(navigation.radius, '24px');
    await customerPage.waitForSelector('.storefront-product-card').catch(async (error) => {
        error.message += `\nCustomer page: ${customerPage.url()}\n${await customerPage.evaluate(() => document.body.innerText.slice(-4000))}`;
        throw error;
    });
    await customerPage.locator('.storefront-product-card').click();
    await customerPage.waitForSelector('[data-platform-purchase]');
    await customerPage.waitForFunction(() => getComputedStyle(document.querySelector('[data-platform-purchase]'), '::before').animationName === 'platform-neon-rotate');
    const buy = await customerPage.$eval('[data-platform-button="primary"]', (el) => ({ radius: getComputedStyle(el).borderTopLeftRadius, background: getComputedStyle(el).backgroundColor }));
    assert.equal(buy.radius, '24px'); assert.equal(buy.background, 'rgba(0, 0, 0, 0)');
    await customerPage.evaluate(() => { localStorage.setItem('oscar-theme', 'dark'); });
    await customerPage.reload({ waitUntil: 'networkidle2' });
    await customerPage.waitForFunction((background) => document.documentElement.classList.contains('dark') && document.documentElement.style.getPropertyValue('--platform-header-background') === background, {}, styled.chrome.modes.dark.header.background);
    assert.equal(await customerPage.$eval('.app-shell-header-panel', (el) => el.getBoundingClientRect().height), styled.chrome.modes.dark.header.height);
    assert.equal(await customerPage.$eval('.platform-bottom-nav', (el) => getComputedStyle(el).backgroundColor), 'rgb(15, 23, 42)');
    pass('Authenticated dashboard/categories/products, purchase neon/outline buttons and independently published light/dark header and mobile navigation');
    assert.deepEqual(adminPage.testErrors, []); assert.deepEqual(visitor.testErrors, []);
    assert.deepEqual(styledVisitor.testErrors, []); assert.deepEqual(customerPage.testErrors, []);
    pass('No React runtime exceptions during editor, authenticated preview and public catalog interactions');
    console.log(`RESULT ${results.length} browser scenarios passed; isolated DB ${mongoose.connection.name}; production untouched.`);
}

let runTimer;
Promise.race([main(), new Promise((_, reject) => {
    runTimer = setTimeout(() => reject(new Error('The isolated browser audit exceeded its 120-second limit.')), 120000);
})]).catch((error) => { console.error(error.stack); if (viteLog) console.error(viteLog.slice(-1500)); process.exitCode = 1; }).finally(async () => {
    clearTimeout(runTimer);
    if (browser) await browser.close();
    if (vite && vite.exitCode === null) { const exited = once(vite, 'exit'); vite.kill(); await exited; }
    if (httpServer) { httpServer.closeAllConnections(); await new Promise((resolve) => httpServer.close(resolve)); }
    if (mongoose) await mongoose.disconnect();
    if (mongo) await mongo.stop();
    if (uploadedFixture && fs.existsSync(uploadedFixture)) fs.unlinkSync(uploadedFixture);
});
