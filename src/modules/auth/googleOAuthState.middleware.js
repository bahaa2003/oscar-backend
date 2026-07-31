'use strict';

const config = require('../../config/config');
const {
    createGoogleOAuthState,
    consumeGoogleOAuthState,
} = require('./googleOAuthState.service');
const {
    setGoogleOAuthBindingCookie,
    clearGoogleOAuthBindingCookie,
    getGoogleOAuthBindingCookie,
} = require('./googleOAuthState.cookies');

const buildGoogleOAuthFailureRedirect = (reason = 'invalid_state') => {
    const base = String(config.frontend.url || '').replace(/\/+$/, '') || 'http://localhost:3000';
    const params = new URLSearchParams({ oauth_error: reason });
    return `${base}/auth?${params.toString()}`;
};

const startGoogleOAuthState = async (req, res, next) => {
    try {
        const stateContext = await createGoogleOAuthState({ query: req.query || {} });
        setGoogleOAuthBindingCookie(res, stateContext.browserBindingToken, stateContext.maxAgeMs);

        req.googleOAuthState = {
            rawState: stateContext.rawState,
            stateId: stateContext.stateId,
            referrerCode: stateContext.referrerCode,
            codeChallenge: stateContext.codeChallenge,
            codeChallengeMethod: stateContext.codeChallengeMethod,
        };

        next();
    } catch (err) {
        next(err);
    }
};

const consumeGoogleOAuthStateMiddleware = async (req, res, next) => {
    try {
        const stateContext = await consumeGoogleOAuthState({
            rawState: req.query?.state,
            browserBindingToken: getGoogleOAuthBindingCookie(req),
        });

        req.googleOAuthContext = {
            stateId: stateContext.stateId,
            referrerCode: stateContext.referrerCode,
            codeChallenge: stateContext.codeChallenge,
            codeChallengeMethod: stateContext.codeChallengeMethod,
        };

        next();
    } catch (_) {
        clearGoogleOAuthBindingCookie(res);
        res.redirect(buildGoogleOAuthFailureRedirect('invalid_state'));
    }
};

module.exports = {
    startGoogleOAuthState,
    consumeGoogleOAuthStateMiddleware,
    clearGoogleOAuthBindingCookie,
    buildGoogleOAuthFailureRedirect,
};
