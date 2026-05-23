'use strict';

/**
 * Small in-process cache for derived settings payloads.
 *
 * Settings writes must invalidate the affected keys before controllers return,
 * otherwise customer-facing payment screens can keep serving stale data.
 */

const SETTINGS_CACHE_KEYS = Object.freeze({
    paymentGroups: 'settings_paymentGroups',
});

const cache = new Map();

const clone = (value) => {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
};

const get = (key) => clone(cache.get(key));

const set = (key, value) => {
    cache.set(key, clone(value));
    return value;
};

const del = (key) => cache.delete(key);

const clear = () => cache.clear();

module.exports = {
    SETTINGS_CACHE_KEYS,
    get,
    set,
    del,
    clear,
};
