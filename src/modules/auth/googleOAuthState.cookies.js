'use strict';

const config = require('../../config/config');

const GOOGLE_OAUTH_BINDING_COOKIE = 'google_oauth_binding';
const GOOGLE_OAUTH_CALLBACK_PATH = '/api/auth/google/callback';

const parseCookies = (cookieHeader = '') =>
    String(cookieHeader || '')
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean)
        .reduce((cookies, part) => {
            const separatorIndex = part.indexOf('=');
            if (separatorIndex === -1) return cookies;

            const key = part.slice(0, separatorIndex).trim();
            const value = part.slice(separatorIndex + 1);
            if (!key) return cookies;

            try {
                cookies[key] = decodeURIComponent(value);
            } catch (_) {
                cookies[key] = value;
            }

            return cookies;
        }, {});

const appendSetCookieHeader = (res, cookieValue) => {
    const existing = res.getHeader?.('Set-Cookie');
    if (!existing) {
        res.setHeader('Set-Cookie', cookieValue);
        return;
    }

    res.setHeader(
        'Set-Cookie',
        Array.isArray(existing) ? [...existing, cookieValue] : [existing, cookieValue]
    );
};

const isSecureCookieEnabled = () => config.env === 'production';

const buildGoogleOAuthBindingCookie = (
    value,
    {
        maxAgeMs = config.google.oauthStateTtlMs,
        secure = isSecureCookieEnabled(),
    } = {}
) => {
    const maxAgeSeconds = Math.max(0, Math.floor(Number(maxAgeMs || 0) / 1000));
    const encodedValue = encodeURIComponent(String(value || ''));
    const parts = [
        `${GOOGLE_OAUTH_BINDING_COOKIE}=${encodedValue}`,
        'HttpOnly',
        'SameSite=Lax',
        `Path=${GOOGLE_OAUTH_CALLBACK_PATH}`,
        `Max-Age=${maxAgeSeconds}`,
    ];

    if (secure) parts.push('Secure');

    return parts.join('; ');
};

const buildClearGoogleOAuthBindingCookie = ({ secure = isSecureCookieEnabled() } = {}) =>
    buildGoogleOAuthBindingCookie('', { maxAgeMs: 0, secure });

const setGoogleOAuthBindingCookie = (res, token, maxAgeMs) => {
    appendSetCookieHeader(res, buildGoogleOAuthBindingCookie(token, { maxAgeMs }));
};

const clearGoogleOAuthBindingCookie = (res) => {
    appendSetCookieHeader(res, buildClearGoogleOAuthBindingCookie());
};

const getGoogleOAuthBindingCookie = (req) => {
    if (req?.cookies?.[GOOGLE_OAUTH_BINDING_COOKIE]) {
        return req.cookies[GOOGLE_OAUTH_BINDING_COOKIE];
    }

    return parseCookies(req?.headers?.cookie || '')[GOOGLE_OAUTH_BINDING_COOKIE] || '';
};

module.exports = {
    GOOGLE_OAUTH_BINDING_COOKIE,
    GOOGLE_OAUTH_CALLBACK_PATH,
    parseCookies,
    buildGoogleOAuthBindingCookie,
    buildClearGoogleOAuthBindingCookie,
    setGoogleOAuthBindingCookie,
    clearGoogleOAuthBindingCookie,
    getGoogleOAuthBindingCookie,
};
