'use strict';

/**
 * exchangeRateSync.service.js
 *
 * Fetches live exchange rates from the external API and updates the
 * marketRate field on each Currency document.
 *
 * Philosophy (mirrors ProviderProduct → Product):
 *   External API  →  Currency.marketRate  (raw feed)
 *   Admin         →  Currency.platformRate (billing rate, NEVER overwritten here)
 *
 * Sync rules:
 *   - marketRate IS updated every run.
 *   - platformRate is only set when creating a NEW currency from the feed
 *     (default = marketRate × (1 + markupPercentage/100), or just marketRate if markup=0).
 *   - Existing platformRate is NEVER touched — admin owns it.
 *   - If a currency in the DB is NOT in the API response, it is left untouched.
 *
 * External API:
 *   GET https://api.exchangerate.host/latest?base=USD
 *   Response: { base: "USD", rates: { SAR: 3.75, EGP: 50.2, ... } }
 *
 * Environment:
 *   EXCHANGE_RATE_API_URL   (default: https://api.exchangerate.host/latest?base=USD)
 *   EXCHANGE_RATE_API_KEY   (optional — some providers require a key)
 *   EXCHANGE_RATE_TIMEOUT_MS (default: 10000)
 */

const https = require('https');
const http = require('http');
const { Currency } = require('../modules/currency/currency.model');
const { invalidateCurrencyCache } = require('./currencyConverter.service');

// ── Config ────────────────────────────────────────────────────────────────────

const EXCHANGE_RATE_API_URL =
    process.env.EXCHANGE_RATE_API_URL ??
    'https://api.exchangerate.host/latest?base=USD';

const TIMEOUT_MS = parseInt(process.env.EXCHANGE_RATE_TIMEOUT_MS ?? '10000', 10);

// ── Internal: HTTP fetch (no external deps) ───────────────────────────────────

/**
 * Minimal JSON fetch over http/https without axios or node-fetch.
 * Returns the parsed JSON body.
 *
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<Object>}
 */
const _fetchJson = (url, timeoutMs = TIMEOUT_MS) =>
    new Promise((resolve, reject) => {
        const driver = url.startsWith('https') ? https : http;

        const req = driver.get(url, { timeout: timeoutMs }, (res) => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
                return reject(
                    new Error(`Exchange rate API responded with HTTP ${res.statusCode}`)
                );
            }

            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(body));
                } catch (e) {
                    reject(new Error(`Exchange rate API returned invalid JSON: ${e.message}`));
                }
            });
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error(`Exchange rate API request timed out after ${timeoutMs}ms`));
        });

        req.on('error', reject);
    });

// ── Main: syncRates ───────────────────────────────────────────────────────────

/**
 * SyncResult = {
 *   synced:   number,   // currencies updated (marketRate refreshed)
 *   created:  number,   // new currencies auto-created from feed
 *   skipped:  number,   // feed entries with rate = 0 or invalid
 *   errors:   string[], // per-currency errors (never abort the whole run)
 *   syncedAt: Date,
 * }
 */

/**
 * Fetch exchange rates and upsert Currency documents.
 *
 * Safe to call from cron, admin trigger, or tests (mock the URL via env).
 *
 * @param {Object}  [options]
 * @param {Object}  [options.ratesOverride]  - inject rates directly (for unit tests)
 * @returns {Promise<SyncResult>}
 */
const syncRates = async (options = {}) => {
    const syncedAt = new Date();
    const result = {
        synced: 0,
        created: 0,
        skipped: 0,
        errors: [],
        syncedAt,
    };

    // ── Step 1: Fetch rates ────────────────────────────────────────────────────
    let rates;
    if (options.ratesOverride) {
        rates = options.ratesOverride;
    } else {
        let apiUrl = EXCHANGE_RATE_API_URL;
        if (process.env.EXCHANGE_RATE_API_KEY) {
            const separator = apiUrl.includes('?') ? '&' : '?';
            apiUrl += `${separator}access_key=${process.env.EXCHANGE_RATE_API_KEY}`;
        }

        try {
            const json = await _fetchJson(apiUrl);
            rates = json.rates ?? json.conversion_rates ?? json;   // normalise common response shapes
        } catch (err) {
            result.errors.push(`[fetch] ${err.message}`);
            console.error('[ExchangeRateSync] Failed to fetch rates:', err.message);
            return result;
        }
    }

    if (!rates || typeof rates !== 'object' || Object.keys(rates).length === 0) {
        result.errors.push('[parse] No valid rates found in API response.');
        return result;
    }

    // Always ensure USD = 1 (base currency)
    rates['USD'] = 1;

    // ── Step 2: Upsert each rate ───────────────────────────────────────────────
    for (const [code, marketRate] of Object.entries(rates)) {
        // Validate code format
        if (!/^[A-Z]{3}$/.test(code)) {
            result.skipped++;
            continue;
        }

        if (typeof marketRate !== 'number' || marketRate <= 0) {
            result.skipped++;
            continue;
        }

        try {
            const existing = await Currency.findOne({ code });

            if (existing) {
                // Only update marketRate and lastUpdatedAt.
                // platformRate is NEVER touched here.
                await Currency.findOneAndUpdate(
                    { code },
                    {
                        $set: {
                            marketRate,
                            lastUpdatedAt: syncedAt,
                        },
                    }
                );
                invalidateCurrencyCache(code);
                result.synced++;
            } else {
                // Auto-create new currency with platformRate derived from markupPercentage.
                // Admin can adjust platformRate afterwards via the admin API.
                const platformRate = parseFloat(
                    (marketRate * (1 + 0 / 100)).toFixed(6)
                ); // default markup = 0

                await Currency.create({
                    code,
                    name: _getDefaultName(code),
                    symbol: _getDefaultSymbol(code),
                    marketRate,
                    platformRate,
                    markupPercentage: 0,
                    isActive: false,  // auto-created currencies are INACTIVE by default
                    lastUpdatedAt: syncedAt,
                });
                result.created++;
            }
        } catch (err) {
            result.errors.push(`[${code}] ${err.message}`);
            console.error(`[ExchangeRateSync] Failed to process ${code}:`, err.message);
        }
    }

    console.log(
        `[ExchangeRateSync] Done. ` +
        `synced=${result.synced} created=${result.created} ` +
        `skipped=${result.skipped} errors=${result.errors.length}`
    );

    return result;
};

// ── Helpers: default name / symbol table ──────────────────────────────────────

/** Best-effort name for automatically discovered currencies. */
const _getDefaultName = (code) => {
    const names = {
        USD: 'US Dollar',
        EUR: 'Euro',
        GBP: 'British Pound',
        SAR: 'Saudi Riyal',
        AED: 'UAE Dirham',
        EGP: 'Egyptian Pound',
        KWD: 'Kuwaiti Dinar',
        QAR: 'Qatari Riyal',
        BHD: 'Bahraini Dinar',
        OMR: 'Omani Rial',
        JOD: 'Jordanian Dinar',
        TRY: 'Turkish Lira',
        PKR: 'Pakistani Rupee',
        INR: 'Indian Rupee',
        CAD: 'Canadian Dollar',
        AUD: 'Australian Dollar',
    };
    return names[code] ?? `${code} Currency`;
};

/** Best-effort symbol for automatically discovered currencies. */
const _getDefaultSymbol = (code) => {
    const symbols = {
        USD: '$', EUR: '€', GBP: '£', SAR: '﷼',
        AED: 'د.إ', EGP: 'E£', KWD: 'KD', QAR: 'QR',
        BHD: 'BD', OMR: 'OMR', JOD: 'JD', TRY: '₺',
        PKR: '₨', INR: '₹', CAD: 'CA$', AUD: 'A$',
    };
    return symbols[code] ?? code;
};

module.exports = {
    syncRates,
    // Exported for tests
    _fetchJson,
    _getDefaultName,
    _getDefaultSymbol,
};
