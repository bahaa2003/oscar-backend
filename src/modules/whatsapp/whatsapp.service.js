'use strict';

const fs = require('fs/promises');
const path = require('path');
const qrcode = require('qrcode');

let Client = null;
let LocalAuth = null;
let dependencyLoadError = null;

try {
    ({ Client, LocalAuth } = require('whatsapp-web.js'));
} catch (err) {
    dependencyLoadError = err;
}

const WHATSAPP_STATE = Object.freeze({
    IDLE: 'IDLE',
    INITIALIZING: 'INITIALIZING',
    QR_READY: 'QR_READY',
    AUTHENTICATED: 'AUTHENTICATED',
    CONNECTED: 'CONNECTED',
    DISCONNECTED: 'DISCONNECTED',
    ERROR: 'ERROR',
    DISABLED: 'DISABLED',
});

const BACKEND_ROOT = path.resolve(__dirname, '..', '..', '..');
const CLIENT_ID = process.env.WHATSAPP_CLIENT_ID || 'admin-notifications';
const AUTH_DATA_PATH = path.resolve(
    process.env.WHATSAPP_AUTH_DATA_PATH || path.join(process.cwd(), '.wwebjs_auth')
);
const SESSION_DIR = path.resolve(AUTH_DATA_PATH, CLIENT_ID ? `session-${CLIENT_ID}` : 'session');
const WEB_CACHE_PATH = path.resolve(
    process.env.WHATSAPP_WEB_CACHE_PATH || path.join(AUTH_DATA_PATH, 'web-cache')
);
const RECONNECT_DELAY_MS = Number(process.env.WHATSAPP_RECONNECT_DELAY_MS || 5000);
const DESTROY_SETTLE_MS = Number(process.env.WHATSAPP_DESTROY_SETTLE_MS || 1200);
const DELETE_RETRIES = Number(process.env.WHATSAPP_SESSION_DELETE_RETRIES || 6);
const DELETE_RETRY_DELAY_MS = Number(process.env.WHATSAPP_SESSION_DELETE_RETRY_DELAY_MS || 750);
const INIT_WAIT_BEFORE_DESTROY_MS = Number(process.env.WHATSAPP_INIT_WAIT_BEFORE_DESTROY_MS || 15000);

const pm2Worker = process.env.NODE_APP_INSTANCE;
const isEnabledInThisProcess = process.env.WHATSAPP_ENABLED !== 'false'
    && (!pm2Worker || pm2Worker === '0' || process.env.WHATSAPP_PM2_WORKER === pm2Worker);

let client = null;
let initPromise = null;
let operationPromise = null;
let currentOperation = null;
let reconnectTimer = null;
let activeGeneration = 0;

let currentQrDataUrl = null;
let currentState = isEnabledInThisProcess ? WHATSAPP_STATE.IDLE : WHATSAPP_STATE.DISABLED;
let lastError = isEnabledInThisProcess
    ? null
    : {
        message: `WhatsApp manager is disabled in this process${pm2Worker ? ` (PM2 worker ${pm2Worker})` : ''}.`,
        at: new Date().toISOString(),
    };
let lastConnectedAt = null;
let lastDisconnectedAt = null;
let isInitializing = false;
let automaticReconnectEnabled = true;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const log = (level, message, meta = null) => {
    const suffix = meta ? ` ${JSON.stringify(meta)}` : '';
    console[level](`[WhatsApp] ${message}${suffix}`);
};

const sanitizeErrorMessage = (err) => {
    const raw = err?.message || String(err || '');
    return raw
        .replaceAll(SESSION_DIR, '[whatsapp-session-path]')
        .replaceAll(AUTH_DATA_PATH, '[whatsapp-auth-path]')
        .replaceAll(WEB_CACHE_PATH, '[whatsapp-cache-path]');
};

const setState = (state) => {
    currentState = state;
};

const setLastError = (err) => {
    lastError = err
        ? {
            message: sanitizeErrorMessage(err),
            at: new Date().toISOString(),
        }
        : null;
};

const normalizeAdminChatId = () => {
    const rawNumber = String(process.env.ADMIN_NOTIFICATION_NUMBER || '').trim();
    if (!rawNumber) return null;

    const normalized = rawNumber.replace(/[^\d]/g, '');
    return normalized ? `${normalized}@c.us` : null;
};

const isBrowserConnected = (browser) => {
    try {
        return Boolean(browser?.isConnected?.());
    } catch (_err) {
        return false;
    }
};

const getBrowserPid = (browser) => {
    try {
        return browser?.process?.()?.pid || null;
    } catch (_err) {
        return null;
    }
};

const getStatus = () => {
    const qrDataUrl = currentState === WHATSAPP_STATE.QR_READY ? currentQrDataUrl : null;
    const isReady = currentState === WHATSAPP_STATE.CONNECTED;

    return {
        state: currentState,
        qrDataUrl,
        qrCode: qrDataUrl,
        hasQrCode: Boolean(qrDataUrl),
        isReady,
        isConnected: isReady,
        isInitializing,
        isResetting: currentOperation === 'reset',
        isReconnecting: currentOperation === 'reconnect',
        lastError,
        lastConnectedAt,
        lastDisconnectedAt,
        adminNumberConfigured: Boolean(normalizeAdminChatId()),
        dependencyAvailable: Boolean(Client && LocalAuth),
        autoReconnectEnabled: automaticReconnectEnabled,
    };
};

const ensureManagerAvailable = () => {
    if (!isEnabledInThisProcess) {
        throw new Error('WhatsApp manager is disabled in this process. Run the WhatsApp backend in a single PM2 worker.');
    }

    if (!Client || !LocalAuth) {
        throw new Error(
            `whatsapp-web.js is not installed or could not be loaded. ${dependencyLoadError?.message || ''}`.trim()
        );
    }
};

const clearReconnectTimer = () => {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
};

const shouldIgnoreClientEvent = (eventClient, generation) => eventClient !== client || generation !== activeGeneration;

const scheduleReconnect = () => {
    if (!automaticReconnectEnabled || reconnectTimer || initPromise || operationPromise || !isEnabledInThisProcess) {
        return;
    }

    log('info', 'scheduled reconnect', { delayMs: RECONNECT_DELAY_MS });
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;

        if (!automaticReconnectEnabled || operationPromise) {
            log('info', 'automatic reconnect skipped because an operation is active');
            return;
        }

        initializeWhatsAppClient({ reason: 'automatic-reconnect' }).catch((err) => {
            setLastError(err);
            setState(WHATSAPP_STATE.ERROR);
            log('error', 'automatic reconnect failed', { error: sanitizeErrorMessage(err) });
        });
    }, RECONNECT_DELAY_MS);
};

const attachClientEvents = (nextClient, generation) => {
    nextClient.on('qr', async (qr) => {
        if (shouldIgnoreClientEvent(nextClient, generation)) return;

        try {
            currentQrDataUrl = await qrcode.toDataURL(qr);
            setLastError(null);
            setState(WHATSAPP_STATE.QR_READY);
            log('info', 'QR code generated');
        } catch (err) {
            currentQrDataUrl = null;
            setLastError(err);
            setState(WHATSAPP_STATE.ERROR);
            log('error', 'failed to generate QR code', { error: sanitizeErrorMessage(err) });
        }
    });

    nextClient.on('authenticated', () => {
        if (shouldIgnoreClientEvent(nextClient, generation)) return;

        currentQrDataUrl = null;
        setLastError(null);
        setState(WHATSAPP_STATE.AUTHENTICATED);
        log('info', 'authenticated');
    });

    nextClient.on('ready', () => {
        if (shouldIgnoreClientEvent(nextClient, generation)) return;

        currentQrDataUrl = null;
        setLastError(null);
        setState(WHATSAPP_STATE.CONNECTED);
        lastConnectedAt = new Date().toISOString();
        log('info', 'client ready');
    });

    nextClient.on('auth_failure', (message) => {
        if (shouldIgnoreClientEvent(nextClient, generation)) return;

        currentQrDataUrl = null;
        setLastError(new Error(message || 'WhatsApp authentication failed.'));
        setState(WHATSAPP_STATE.ERROR);
        log('error', 'authentication failed', { error: sanitizeErrorMessage(new Error(message || 'auth_failure')) });
    });

    nextClient.on('disconnected', (reason) => {
        if (shouldIgnoreClientEvent(nextClient, generation)) return;

        currentQrDataUrl = null;
        client = null;
        lastDisconnectedAt = new Date().toISOString();
        setLastError(reason ? new Error(String(reason)) : null);
        setState(WHATSAPP_STATE.DISCONNECTED);
        log('warn', 'disconnected', { reason: reason || 'unknown' });
        scheduleReconnect();
    });

    nextClient.on('change_state', (state) => {
        if (shouldIgnoreClientEvent(nextClient, generation)) return;
        log('info', 'client state changed', { state });
    });

    nextClient.on('loading_screen', (percent, message) => {
        if (shouldIgnoreClientEvent(nextClient, generation)) return;
        log('info', 'loading screen', { percent, message });
    });
};

const buildClient = () => {
    ensureManagerAvailable();

    return new Client({
        authStrategy: new LocalAuth({
            clientId: CLIENT_ID,
            dataPath: AUTH_DATA_PATH,
            rmMaxRetries: DELETE_RETRIES,
        }),
        webVersionCache: {
            type: 'local',
            path: WEB_CACHE_PATH,
        },
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            ],
        },
    });
};

const waitForBrowserClose = async (browser) => {
    if (!browser) return;

    const pid = getBrowserPid(browser);
    const startedAt = Date.now();

    while (Date.now() - startedAt < DESTROY_SETTLE_MS) {
        if (!isBrowserConnected(browser)) break;
        await delay(100);
    }

    log('info', 'browser close wait completed', {
        pid,
        connected: isBrowserConnected(browser),
    });
};

const safeCloseBrowser = async (browser) => {
    if (!browser || !isBrowserConnected(browser)) return;

    try {
        log('info', 'closing Puppeteer browser', { pid: getBrowserPid(browser) });
        await browser.close();
    } catch (err) {
        log('warn', 'browser close failed', { error: sanitizeErrorMessage(err) });
    }
};

const waitForActiveInitialization = async () => {
    if (!initPromise) return;

    log('info', 'waiting for active initialization before client destruction');
    await Promise.race([
        initPromise.catch(() => null),
        delay(INIT_WAIT_BEFORE_DESTROY_MS),
    ]);
};

const destroyCurrentClient = async ({ logout = false } = {}) => {
    clearReconnectTimer();
    await waitForActiveInitialization();

    const existingClient = client;
    const browser = existingClient?.pupBrowser || null;
    const generation = activeGeneration;

    activeGeneration += 1;
    client = null;
    currentQrDataUrl = null;

    if (!existingClient) {
        log('info', 'client destruction skipped; no active client');
        setState(WHATSAPP_STATE.DISCONNECTED);
        lastDisconnectedAt = new Date().toISOString();
        return;
    }

    log('info', 'client destruction started', {
        logout,
        generation,
        browserPid: getBrowserPid(browser),
    });

    try {
        existingClient.removeAllListeners?.();

        if (logout) {
            try {
                if (existingClient.pupPage && isBrowserConnected(browser)) {
                    log('info', 'logging out current WhatsApp session');
                    await existingClient.logout();
                } else {
                    log('info', 'logout skipped because browser/page is not available');
                }
            } catch (err) {
                log('warn', 'logout failed; continuing reset cleanup', { error: sanitizeErrorMessage(err) });
            }
        }

        try {
            await existingClient.destroy();
            log('info', 'client destroy completed');
        } catch (err) {
            log('warn', 'client destroy failed; attempting browser close', { error: sanitizeErrorMessage(err) });
        }

        await safeCloseBrowser(browser);
        await waitForBrowserClose(browser);
    } finally {
        currentQrDataUrl = null;
        setState(WHATSAPP_STATE.DISCONNECTED);
        lastDisconnectedAt = new Date().toISOString();
        isInitializing = false;
        log('info', 'client destruction finished');
    }
};

const assertSafeDeletePath = (targetPath, parentPath, { allowParent = false } = {}) => {
    const resolvedTarget = path.resolve(targetPath);
    const resolvedParent = path.resolve(parentPath);
    const root = path.parse(resolvedTarget).root;
    const relativeToParent = path.relative(resolvedParent, resolvedTarget);

    if (!resolvedTarget || resolvedTarget === root) {
        throw new Error('Refusing to delete filesystem root.');
    }

    if (resolvedTarget === BACKEND_ROOT) {
        throw new Error('Refusing to delete backend root.');
    }

    if (!allowParent && resolvedTarget === resolvedParent) {
        throw new Error('Refusing to delete entire WhatsApp auth directory.');
    }

    if (relativeToParent.startsWith('..') || path.isAbsolute(relativeToParent)) {
        throw new Error('Refusing to delete path outside the WhatsApp auth directory.');
    }

    return resolvedTarget;
};

const removePathWithRetries = async (targetPath, label) => {
    for (let attempt = 1; attempt <= DELETE_RETRIES; attempt += 1) {
        try {
            await fs.rm(targetPath, {
                recursive: true,
                force: true,
                maxRetries: 1,
                retryDelay: DELETE_RETRY_DELAY_MS,
            });
            log('info', `${label} cleanup completed`, { path: targetPath });
            return;
        } catch (err) {
            if (err?.code === 'ENOENT') {
                log('info', `${label} cleanup skipped; path does not exist`, { path: targetPath });
                return;
            }

            if (attempt >= DELETE_RETRIES) {
                throw err;
            }

            log('warn', `${label} cleanup retry`, {
                path: targetPath,
                attempt,
                error: sanitizeErrorMessage(err),
            });
            await delay(DELETE_RETRY_DELAY_MS);
        }
    }
};

const clearLocalSession = async () => {
    const sessionPath = assertSafeDeletePath(SESSION_DIR, AUTH_DATA_PATH);
    log('info', 'session path cleanup started', { path: sessionPath });
    await removePathWithRetries(sessionPath, 'session path');
};

const clearWebCacheIfNecessary = async () => {
    const shouldClear = process.env.WHATSAPP_CLEAR_WEB_CACHE_ON_RESET === 'true'
        || /webversion|cache|version/i.test(lastError?.message || '');

    if (!shouldClear) {
        log('info', 'web cache cleanup skipped; not necessary');
        return;
    }

    const cachePath = assertSafeDeletePath(WEB_CACHE_PATH, AUTH_DATA_PATH);
    log('info', 'web cache cleanup started', { path: cachePath });
    await removePathWithRetries(cachePath, 'web cache');
};

const initializeWhatsAppClient = async ({ force = false, reason = 'manual' } = {}) => {
    try {
        ensureManagerAvailable();
    } catch (err) {
        setLastError(err);
        setState(WHATSAPP_STATE.DISABLED);
        log('warn', 'initialization skipped', { error: sanitizeErrorMessage(err) });
        return getStatus();
    }

    if (initPromise) {
        log('info', 'initialization promise reused', { reason });
        return initPromise;
    }

    if (client && !force) {
        return getStatus();
    }

    initPromise = (async () => {
        const generation = activeGeneration + 1;

        isInitializing = true;
        activeGeneration = generation;
        currentQrDataUrl = null;
        setLastError(null);
        setState(WHATSAPP_STATE.INITIALIZING);
        log('info', 'initialization started', {
            reason,
            clientId: CLIENT_ID,
            authDataPath: AUTH_DATA_PATH,
            sessionPath: SESSION_DIR,
            cachePath: WEB_CACHE_PATH,
        });

        try {
            const nextClient = buildClient();
            client = nextClient;
            attachClientEvents(nextClient, generation);

            await nextClient.initialize();
            return getStatus();
        } catch (err) {
            if (generation === activeGeneration) {
                client = null;
                currentQrDataUrl = null;
                setLastError(err);
                setState(WHATSAPP_STATE.ERROR);
            }

            log('error', 'initialization failed', { error: sanitizeErrorMessage(err) });
            return getStatus();
        } finally {
            if (generation === activeGeneration) {
                isInitializing = false;
            }
            initPromise = null;
        }
    })();

    return initPromise;
};

const runExclusiveOperation = async (name, handler) => {
    if (operationPromise) {
        log('warn', 'duplicate operation prevented', {
            requested: name,
            running: currentOperation,
        });
        return operationPromise;
    }

    currentOperation = name;
    operationPromise = (async () => {
        try {
            return await handler();
        } finally {
            currentOperation = null;
            operationPromise = null;
        }
    })();

    return operationPromise;
};

const reconnectWhatsAppClient = async () => runExclusiveOperation('reconnect', async () => {
    log('info', 'reconnect started');
    automaticReconnectEnabled = false;
    clearReconnectTimer();

    try {
        await destroyCurrentClient({ logout: false });
        automaticReconnectEnabled = true;
        const status = await initializeWhatsAppClient({ force: true, reason: 'manual-reconnect' });
        log('info', 'reconnect completed');
        return status;
    } catch (err) {
        setLastError(err);
        setState(WHATSAPP_STATE.ERROR);
        log('error', 'reconnect failed', { error: sanitizeErrorMessage(err) });
        return getStatus();
    } finally {
        automaticReconnectEnabled = true;
    }
});

const resetWhatsAppClient = async () => runExclusiveOperation('reset', async () => {
    log('info', 'reset started');
    automaticReconnectEnabled = false;
    clearReconnectTimer();

    try {
        await destroyCurrentClient({ logout: true });
        await clearLocalSession();
        await clearWebCacheIfNecessary();

        automaticReconnectEnabled = true;
        const status = await initializeWhatsAppClient({ force: true, reason: 'manual-reset' });
        log('info', 'reset completed');
        return status;
    } catch (err) {
        setLastError(err);
        setState(WHATSAPP_STATE.ERROR);
        log('error', 'reset failed', { error: sanitizeErrorMessage(err) });
        return getStatus();
    } finally {
        automaticReconnectEnabled = true;
    }
});

const destroyWhatsAppClient = async () => {
    automaticReconnectEnabled = false;
    clearReconnectTimer();
    await destroyCurrentClient({ logout: false });
};

const sendAdminNotification = async (message) => {
    const chatId = normalizeAdminChatId();

    if (!chatId) {
        throw new Error('ADMIN_NOTIFICATION_NUMBER is not configured.');
    }

    if (!client || currentState !== WHATSAPP_STATE.CONNECTED) {
        throw new Error('WhatsApp client is not connected.');
    }

    const safeMessage = String(message || '').trim();
    if (!safeMessage) {
        throw new Error('WhatsApp notification message cannot be empty.');
    }

    return client.sendMessage(chatId, safeMessage);
};

module.exports = {
    WHATSAPP_STATE,
    AUTH_DATA_PATH,
    CLIENT_ID,
    SESSION_DIR,
    WEB_CACHE_PATH,
    initializeWhatsAppClient,
    reconnectWhatsAppClient,
    resetWhatsAppClient,
    destroyWhatsAppClient,
    destroyCurrentClient,
    clearLocalSession,
    getStatus,
    sendAdminNotification,
};
