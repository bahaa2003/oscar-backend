'use strict';

/**
 * google.strategy.js
 *
 * Passport strategy for Google OAuth 2.0.
 *
 * Flow:
 *   1. User clicks "Login with Google"
 *   2. Google authenticates and calls back with profile
 *   3. We find-or-create a User by googleId (or email as fallback)
 *   4. New users → status=ACTIVE, verified=true (email trust delegated to Google)
 *   5. Existing email/password users → googleId is linked on first Google login
 *   6. The resolved user is attached to req.user by Passport
 *
 * The strategy does NOT issue a JWT — that happens in the route handler
 * after Passport calls next().
 */

const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { User, ROLES, USER_STATUS } = require('../modules/users/user.model');
const { getHighestPercentageGroup } = require('../modules/groups/group.service');
const config = require('../config/config');

// ─── Strategy Registration ────────────────────────────────────────────────────
// Only register if credentials are configured.
// Without credentials the /google route returns 503 (handled in auth.routes.js).

if (config.google.clientId && config.google.clientSecret) {
    passport.use(
        new GoogleStrategy(
            {
                clientID: config.google.clientId,
                clientSecret: config.google.clientSecret,
                callbackURL: config.google.callbackUrl,
                // Pass the full request so we can read state if needed in future
                passReqToCallback: false,
            },
            async (accessToken, refreshToken, profile, done) => {
                try {
                    const googleId = profile.id;
                    const email = (profile.emails?.[0]?.value ?? '').toLowerCase();
                    const name = profile.displayName || email.split('@')[0];

                    if (!email) {
                        return done(new Error('Google account has no accessible email address.'));
                    }

                    // ── 1. Try find by googleId ────────────────────────────────────
                    let user = await User.findOne({ googleId });

                    if (user) {
                        return done(null, user);
                    }

                    // ── 2. Try find by email (link existing account) ───────────────
                    user = await User.findOne({ email });

                    if (user) {
                        // Link the Google profile to the existing account
                        user.googleId = googleId;
                        user.verified = true;   // email already confirmed via Google
                        await user.save();
                        return done(null, user);
                    }

                    // ── 3. Create brand-new user ───────────────────────────────────
                    const group = await getHighestPercentageGroup();

                    user = await User.create({
                        name,
                        email,
                        googleId,
                        role: ROLES.CUSTOMER,
                        groupId: group._id,
                        status: USER_STATUS.ACTIVE,
                        verified: true,   // Google guarantees email ownership
                        // No password set — comparePassword never called for OAuth users
                    });

                    return done(null, user);

                } catch (err) {
                    return done(err);
                }
            }
        )
    );

    // ─── Minimal session serialization ───────────────────────────────────────────
    // We use stateless JWTs so session is not used in production.
    // These stubs are required by Passport when session middleware is present.
    passport.serializeUser((user, done) => done(null, user._id));
    passport.deserializeUser(async (id, done) => {
        try {
            const user = await User.findById(id);
            done(null, user);
        } catch (err) {
            done(err);
        }
    });

}   // end: if (config.google.clientId && config.google.clientSecret)

module.exports = passport;
