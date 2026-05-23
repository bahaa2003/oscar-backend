'use strict';

/**
 * activation.test.js — User Activation Flow Test Suite
 * ──────────────────────────────────────────────────────
 * Tests cover:
 *
 *   REGISTRATION
 *   1.  register returns no token — just user + active message
 *   2.  registered user has status = ACTIVE
 *   3.  registered user cannot log in immediately (unverified email)
 *
 *   LOGIN BLOCKING
 *   4.  PENDING user cannot log in
 *   5.  REJECTED user cannot log in
 *   6.  ACTIVE user can log in and receives a JWT
 *   7.  Wrong password still returns generic error (not status-specific)
 *   8.  Non-existent email returns generic error (timing-safe)
 *
 *   APPROVE USER
 *   9.  Admin can approve a PENDING user → status = ACTIVE, audit fields set
 *   10. Admin can approve a REJECTED user (re-approve) → status = ACTIVE
 *   11. Cannot approve an already ACTIVE user (ALREADY_ACTIVE)
 *   12. approveUser records the admin's ID in approvedBy
 *   13. Approving clears prior rejectedBy / rejectedAt fields
 *
 *   REJECT USER
 *   14. Admin can reject a PENDING user → status = REJECTED, audit fields set
 *   15. Admin can reject an ACTIVE user (revoke access) → status = REJECTED
 *   16. Cannot reject an already REJECTED user (ALREADY_REJECTED)
 *   17. rejectUser records the admin's ID in rejectedBy
 *   18. Rejecting clears prior approvedBy / approvedAt fields
 *
 *   FULL LIFECYCLE FLOWS
 *   19. PENDING → approve → login succeeds
 *   20. ACTIVE  → reject  → login fails
 *   21. REJECTED → re-approve → login succeeds again
 *
 *   EDGE CASES
 *   22. Cannot approve non-existent user
 *   23. Cannot reject non-existent user
 *   24. isActive virtual equals true only when status === ACTIVE
 */

const { register, login } = require('../modules/auth/auth.service');
const userService = require('../modules/users/user.service');
const { User } = require('../modules/users/user.model');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createGroup,
    createCustomer,
    createAdmin,
    freshUser,
    USER_STATUS,
} = require('./testHelpers');
const mongoose = require('mongoose');

// ─── Suite Lifecycle ──────────────────────────────────────────────────────────

beforeAll(async () => {
    await connectTestDB();
});

afterAll(async () => {
    await disconnectTestDB();
});

beforeEach(async () => {
    await clearCollections();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Unique email for each test. */
const uniqueEmail = () =>
    `user-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;

/** Register and return the created user. Requires a group to exist first. */
const registerUser = async () => {
    await createGroup({ name: 'Standard', percentage: 0 });
    return register({ name: 'Jane Doe', email: uniqueEmail(), password: 'ValidPass@1' });
};

// ─────────────────────────────────────────────────────────────────────────────
// 1–3. REGISTRATION
// ─────────────────────────────────────────────────────────────────────────────

describe('Registration', () => {
    it('returns no token — only user profile + verification message', async () => {
        const result = await registerUser();

        expect(result.token).toBeUndefined();
        expect(result.user).toBeDefined();
        expect(result.user.status).toBe(USER_STATUS.ACTIVE);
        // Message explains verification flow
        expect(result.message).toMatch(/verify|verified|email/i);
    });

    it('newly registered user has status ACTIVE in the database', async () => {
        const result = await registerUser();
        const dbUser = await User.findById(result.user._id);
        expect(dbUser.status).toBe(USER_STATUS.ACTIVE);
    });

    it('newly registered user cannot log in immediately (unverified email)', async () => {
        await createGroup({ name: 'StandardGr', percentage: 0 });
        const email = uniqueEmail();
        await register({ name: 'Jane', email, password: 'ValidPass@1' });

        await expect(
            login({ email, password: 'ValidPass@1' })
        ).rejects.toMatchObject({ statusCode: 401 });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4–8. LOGIN BLOCKING
// ─────────────────────────────────────────────────────────────────────────────

describe('Login blocking', () => {
    let group;

    beforeEach(async () => {
        group = await createGroup({ name: 'Gr', percentage: 0 });
    });

    it('PENDING user cannot log in', async () => {
        await createCustomer({
            groupId: group._id, status: USER_STATUS.PENDING,
            email: 'pending@test.com', password: 'pass12345'
        });

        await expect(
            login({ email: 'pending@test.com', password: 'pass12345' })
        ).rejects.toMatchObject({ statusCode: 401 });
    });

    it('REJECTED user cannot log in', async () => {
        await createCustomer({
            groupId: group._id, status: USER_STATUS.REJECTED,
            email: 'rejected@test.com', password: 'pass12345'
        });

        await expect(
            login({ email: 'rejected@test.com', password: 'pass12345' })
        ).rejects.toMatchObject({ statusCode: 401 });
    });

    it('ACTIVE user can log in and receives a JWT', async () => {
        await createCustomer({
            groupId: group._id, status: USER_STATUS.ACTIVE,
            email: 'active@test.com', password: 'pass12345'
        });

        // createCustomer hashes the password via pre-save, so we must login with raw
        // Actually, createCustomer uses User.create which triggers the pre-save hook.
        // The password stored is hashed — the comparePassword method handles this.
        const result = await login({ email: 'active@test.com', password: 'pass12345' });

        expect(result.token).toBeDefined();
        expect(typeof result.token).toBe('string');
        expect(result.user.status).toBe(USER_STATUS.ACTIVE);
    });

    it('wrong password for ACTIVE user returns generic 401 (not status message)', async () => {
        await createCustomer({
            groupId: group._id, status: USER_STATUS.ACTIVE,
            email: 'active2@test.com', password: 'pass12345'
        });

        const err = await login({ email: 'active2@test.com', password: 'wrongpassword' })
            .catch(e => e);

        expect(err.statusCode).toBe(401);
        expect(err.message).toMatch(/invalid email or password/i);
    });

    it('non-existent email returns generic 401 (timing-safe, no user enumeration)', async () => {
        const err = await login({ email: 'nobody@test.com', password: 'anything' })
            .catch(e => e);

        expect(err.statusCode).toBe(401);
        expect(err.message).toMatch(/invalid email or password/i);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9–13. APPROVE USER
// ─────────────────────────────────────────────────────────────────────────────

describe('approveUser', () => {
    let admin;
    let group;

    beforeEach(async () => {
        group = await createGroup({ name: 'Gr', percentage: 0 });
        admin = await createAdmin();
    });

    it('PENDING → ACTIVE: sets status, approvedBy, approvedAt', async () => {
        const customer = await createCustomer({
            groupId: group._id,
            status: USER_STATUS.PENDING,
        });

        const result = await userService.approveUser(customer._id, admin._id);

        expect(result.status).toBe(USER_STATUS.ACTIVE);
        expect(result.approvedBy.toString()).toBe(admin._id.toString());
        expect(result.approvedAt).toBeDefined();
        expect(result.approvedAt).not.toBeNull();

        // Verify persisted
        const fresh = await freshUser(customer._id);
        expect(fresh.status).toBe(USER_STATUS.ACTIVE);
    });

    it('REJECTED → ACTIVE: re-approval succeeds', async () => {
        const customer = await createCustomer({
            groupId: group._id,
            status: USER_STATUS.REJECTED,
        });

        const result = await userService.approveUser(customer._id, admin._id);
        expect(result.status).toBe(USER_STATUS.ACTIVE);
    });

    it('ACTIVE → ACTIVE: throws ALREADY_ACTIVE', async () => {
        const customer = await createCustomer({
            groupId: group._id,
            status: USER_STATUS.ACTIVE,
        });

        await expect(
            userService.approveUser(customer._id, admin._id)
        ).rejects.toMatchObject({ code: 'ALREADY_ACTIVE' });

        // Status must be unchanged
        const fresh = await freshUser(customer._id);
        expect(fresh.status).toBe(USER_STATUS.ACTIVE);
    });

    it('records the admin ID in approvedBy', async () => {
        const customer = await createCustomer({ groupId: group._id, status: USER_STATUS.PENDING });
        await userService.approveUser(customer._id, admin._id);

        const fresh = await freshUser(customer._id);
        expect(fresh.approvedBy.toString()).toBe(admin._id.toString());
    });

    it('approving a previously rejected user clears rejectedBy / rejectedAt', async () => {
        const customer = await createCustomer({ groupId: group._id, status: USER_STATUS.REJECTED });

        // Simulate prior rejection data
        await User.findByIdAndUpdate(customer._id, {
            rejectedBy: admin._id,
            rejectedAt: new Date(),
        });

        await userService.approveUser(customer._id, admin._id);

        const fresh = await freshUser(customer._id);
        expect(fresh.rejectedBy).toBeNull();
        expect(fresh.rejectedAt).toBeNull();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 14–18. REJECT USER
// ─────────────────────────────────────────────────────────────────────────────

describe('rejectUser', () => {
    let admin;
    let group;

    beforeEach(async () => {
        group = await createGroup({ name: 'Gr', percentage: 0 });
        admin = await createAdmin();
    });

    it('PENDING → REJECTED: sets status, rejectedBy, rejectedAt', async () => {
        const customer = await createCustomer({
            groupId: group._id,
            status: USER_STATUS.PENDING,
        });

        const result = await userService.rejectUser(customer._id, admin._id);

        expect(result.status).toBe(USER_STATUS.REJECTED);
        expect(result.rejectedBy.toString()).toBe(admin._id.toString());
        expect(result.rejectedAt).toBeDefined();

        // Verify persisted
        const fresh = await freshUser(customer._id);
        expect(fresh.status).toBe(USER_STATUS.REJECTED);
    });

    it('ACTIVE → REJECTED: revoking access succeeds', async () => {
        const customer = await createCustomer({
            groupId: group._id,
            status: USER_STATUS.ACTIVE,
        });

        const result = await userService.rejectUser(customer._id, admin._id);
        expect(result.status).toBe(USER_STATUS.REJECTED);
    });

    it('REJECTED → REJECTED: throws ALREADY_REJECTED', async () => {
        const customer = await createCustomer({
            groupId: group._id,
            status: USER_STATUS.REJECTED,
        });

        await expect(
            userService.rejectUser(customer._id, admin._id)
        ).rejects.toMatchObject({ code: 'ALREADY_REJECTED' });

        // Status must be unchanged
        const fresh = await freshUser(customer._id);
        expect(fresh.status).toBe(USER_STATUS.REJECTED);
    });

    it('records the admin ID in rejectedBy', async () => {
        const customer = await createCustomer({ groupId: group._id, status: USER_STATUS.PENDING });
        await userService.rejectUser(customer._id, admin._id);

        const fresh = await freshUser(customer._id);
        expect(fresh.rejectedBy.toString()).toBe(admin._id.toString());
    });

    it('rejecting an active user clears approvedBy / approvedAt', async () => {
        const customer = await createCustomer({ groupId: group._id, status: USER_STATUS.ACTIVE });

        // Simulate prior approval data
        await User.findByIdAndUpdate(customer._id, {
            approvedBy: admin._id,
            approvedAt: new Date(),
        });

        await userService.rejectUser(customer._id, admin._id);

        const fresh = await freshUser(customer._id);
        expect(fresh.approvedBy).toBeNull();
        expect(fresh.approvedAt).toBeNull();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 19–21. FULL LIFECYCLE FLOWS
// ─────────────────────────────────────────────────────────────────────────────

describe('Full lifecycle flows', () => {
    let admin;

    beforeEach(async () => {
        await createGroup({ name: 'GrDefault', percentage: 0 });
        admin = await createAdmin();
    });

    it('register → verify email → login succeeds with JWT', async () => {
        const email = uniqueEmail();
        const password = 'ValidPass@1';
        await register({ name: 'User', email, password });

        // Set verified=true as if user clicked the email link
        await User.findOneAndUpdate({ email }, { verified: true });

        const activeUser = await User.findOne({ email });
        expect(activeUser.status).toBe(USER_STATUS.ACTIVE);

        // Now login should succeed (ACTIVE + verified)
        const { token } = await login({ email, password });
        expect(token).toBeDefined();
    });

    it('ACTIVE → reject → login blocked', async () => {
        const email = 'active-flow@test.com';
        const group = await require('../modules/groups/group.model').findOne({});
        const customer = await createCustomer({
            groupId: group._id,
            status: USER_STATUS.ACTIVE,
            email,
            password: 'ValidPass@1',
        });

        // Login works before rejection
        const { token: beforeToken } = await login({ email, password: 'ValidPass@1' });
        expect(beforeToken).toBeDefined();

        // Admin rejects
        await userService.rejectUser(customer._id, admin._id);

        // Login now blocked
        await expect(
            login({ email, password: 'ValidPass@1' })
        ).rejects.toMatchObject({ statusCode: 401 });
    });

    it('register → reject → login blocked → re-approve → login succeeds', async () => {
        const email = uniqueEmail();
        await register({ name: 'User', email, password: 'ValidPass@1' });

        // Set verified=true as if user clicked the email link
        await User.findOneAndUpdate({ email }, { verified: true });

        const user = await User.findOne({ email });
        expect(user.status).toBe(USER_STATUS.ACTIVE);

        // Admin rejects
        await userService.rejectUser(user._id, admin._id);
        await expect(
            login({ email, password: 'ValidPass@1' })
        ).rejects.toMatchObject({ statusCode: 401 });

        // Admin re-approves
        await userService.approveUser(user._id, admin._id);
        const { token } = await login({ email, password: 'ValidPass@1' });
        expect(token).toBeDefined();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 22–24. EDGE CASES
// ─────────────────────────────────────────────────────────────────────────────

describe('Edge cases', () => {
    it('approveUser throws NotFoundError for a non-existent user', async () => {
        const fakeId = new mongoose.Types.ObjectId();
        await expect(
            userService.approveUser(fakeId, new mongoose.Types.ObjectId())
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('rejectUser throws NotFoundError for a non-existent user', async () => {
        const fakeId = new mongoose.Types.ObjectId();
        await expect(
            userService.rejectUser(fakeId, new mongoose.Types.ObjectId())
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('isActive virtual reflects status correctly', async () => {
        const group = await createGroup({ name: 'Gr', percentage: 0 });
        const active = await createCustomer({ groupId: group._id, status: USER_STATUS.ACTIVE });
        const pending = await createCustomer({ groupId: group._id, status: USER_STATUS.PENDING });
        const rejected = await createCustomer({ groupId: group._id, status: USER_STATUS.REJECTED });

        expect(active.isActive).toBe(true);
        expect(pending.isActive).toBe(false);
        expect(rejected.isActive).toBe(false);
    });
});
