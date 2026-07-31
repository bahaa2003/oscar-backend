'use strict';

const authService = require('./auth.service');
const { sendSuccess, sendCreated } = require('../../shared/utils/apiResponse');
const catchAsync = require('../../shared/utils/catchAsync');
const config = require('../../config/config');
const { mapRegistrationReferrerCodeAliases } = require('../referrals/referralAttribution.service');

const register = catchAsync(async (req, res) => {
    const { name, email, password, currency, country, phone, username } = req.body;
    const { referrerCode } = mapRegistrationReferrerCodeAliases(req.body);
    const result = await authService.register({
        name,
        email,
        password,
        currency,
        country,
        phone,
        username,
        referrerCode,
    });

    sendCreated(res, result, result.message);
});

const login = catchAsync(async (req, res) => {
    const { email, password } = req.body;
    const result = await authService.login({ email, password });
    sendSuccess(res, result, 'Logged in successfully.');
});

const verifyEmail = async (req, res) => {
    const redirectUrl = process.env.FRONTEND_VERIFY_REDIRECT_URL || 'http://localhost:5173/email-verified';
    try {
        const { token } = req.query;
        if (!token) {
            return res.redirect(`${redirectUrl}?status=error&message=${encodeURIComponent('Token is required')}`);
        }

        await authService.verifyEmail(token);
        return res.redirect(`${redirectUrl}?status=success`);
    } catch (error) {
        return res.redirect(`${redirectUrl}?status=error&message=${encodeURIComponent(error.message)}`);
    }
};

const resendVerification = catchAsync(async (req, res) => {
    const { email } = req.body;
    const result = await authService.resendVerification(email);
    sendSuccess(res, null, result.message);
});

const googleCallback = catchAsync(async (req, res) => {
    const frontendBase = String(config.frontend.url || 'http://localhost:3000').replace(/\/+$/, '');

    try {
        const result = await authService.createGoogleOAuthHandoff(req.user, req.googleOAuthContext);

        if (result.status === 'pending') {
            return res.redirect(`${frontendBase}/auth?status=pending`);
        }

        return res.redirect(`${frontendBase}/auth?oauth_code=${encodeURIComponent(result.code)}`);
    } catch (_) {
        return res.redirect(`${frontendBase}/auth?oauth_error=google_auth_failed`);
    }
});

const googleExchange = catchAsync(async (req, res) => {
    const result = await authService.exchangeGoogleOAuthCode({
        code: req.body.code,
        codeVerifier: req.body.codeVerifier,
    });

    sendSuccess(res, result, 'Logged in successfully.');
});

const generate2FA = catchAsync(async (req, res) => {
    const result = await authService.generate2FASecret(req.user._id);
    sendSuccess(res, null, result.message);
});

const enable2FA = catchAsync(async (req, res) => {
    const result = await authService.enable2FA(req.user._id, req.body.code);
    sendSuccess(res, null, result.message);
});

const disable2FA = catchAsync(async (req, res) => {
    const { password } = req.body;
    const result = await authService.disable2FA(req.user._id, { password });
    sendSuccess(res, null, result.message);
});

const verify2FA = catchAsync(async (req, res) => {
    const { tempToken, code } = req.body;
    const result = await authService.verify2FA(tempToken, code);
    sendSuccess(res, result, 'Logged in successfully.');
});

module.exports = {
    register,
    login,
    verifyEmail,
    resendVerification,
    googleCallback,
    googleExchange,
    generate2FA,
    enable2FA,
    disable2FA,
    verify2FA,
};
