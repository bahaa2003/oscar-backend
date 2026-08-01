'use strict';

/**
 * Passport strategy for Google OAuth 2.0.
 *
 * The route layer validates and consumes signed OAuth state before this verify
 * callback runs. Referral attribution is applied only for genuinely new Google
 * users; existing Google users and email-linked users keep referral fields as-is.
 */

const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { User, ROLES, USER_STATUS } = require('../modules/users/user.model');
const { getHighestPercentageGroup } = require('../modules/groups/group.service');
const { createUserWithReferralCode } = require('../modules/referrals/referralCode.service');
const {
    resolveRegistrationReferrer,
    createGoogleOAuthAttributionFields,
} = require('../modules/referrals/referralAttribution.service');
const config = require('../config/config');

const verifyGoogleProfile = async (req, accessToken, refreshToken, profile, done) => {
    try {
        const googleId = profile.id;
        const email = (profile.emails?.[0]?.value ?? '').toLowerCase();
        const name = profile.displayName || email.split('@')[0];

        if (!email) {
            return done(new Error('Google account has no accessible email address.'));
        }

        let user = await User.findOne({ googleId });
        if (user) return done(null, user);

        user = await User.findOne({ email });
        if (user) {
            user.googleId = googleId;
            user.verified = true;
            await user.save();
            return done(null, user);
        }

        const group = await getHighestPercentageGroup();
        const referral = await resolveRegistrationReferrer({
            referrerCode: req?.googleOAuthContext?.referrerCode,
            email,
        });
        const referralFields = referral.applied
            ? createGoogleOAuthAttributionFields(referral.referrer)
            : {};

        user = await createUserWithReferralCode({
            name,
            email,
            googleId,
            role: ROLES.CUSTOMER,
            groupId: group._id,
            status: USER_STATUS.ACTIVE,
            verified: true,
            country: null,
            currency: null,
            ...referralFields,
        }, { User });

        return done(null, user);
    } catch (err) {
        return done(err);
    }
};

if (config.google.clientId && config.google.clientSecret) {
    passport.use(
        new GoogleStrategy(
            {
                clientID: config.google.clientId,
                clientSecret: config.google.clientSecret,
                callbackURL: config.google.callbackUrl,
                passReqToCallback: true,
            },
            verifyGoogleProfile
        )
    );

    passport.serializeUser((user, done) => done(null, user._id));
    passport.deserializeUser(async (id, done) => {
        try {
            const user = await User.findById(id);
            done(null, user);
        } catch (err) {
            done(err);
        }
    });
}

module.exports = passport;
module.exports.verifyGoogleProfile = verifyGoogleProfile;
