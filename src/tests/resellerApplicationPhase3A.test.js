'use strict';

const axios = require('axios');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const app = require('../app');
const config = require('../config/config');
const { User, ROLES, RESELLER_STATUS, USER_STATUS, REFERRAL_SOURCE } = require('../modules/users/user.model');
const Group = require('../modules/groups/group.model');
const {
    ResellerApplication,
    RESELLER_APPLICATION_STATUS,
    BUSINESS_TYPES,
} = require('../modules/resellerApplications/resellerApplication.model');
const resellerService = require('../modules/resellerApplications/resellerApplication.service');
const { ReferralCommission, COMMISSION_STATUS } = require('../modules/referrals/referralCommission.model');
const { ReferralPayoutRequest, PAYOUT_METHOD } = require('../modules/referrals/referralPayoutRequest.model');
const { AuditLog } = require('../modules/audit/audit.model');
const { Notification } = require('../modules/notifications/notification.model');
const { RESELLER_APPLICATION_ACTIONS } = require('../modules/audit/audit.constants');
const {
    RESELLER_RECONCILIATION_CODES,
    classifyResellerApplicationState,
} = require('../../scripts/resellerApplicationReconciliationPreflight');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createCustomer,
    createAdmin,
    createGroup,
} = require('./testHelpers');

let server;
let baseURL;

const tokenFor = (user) => jwt.sign(
    { id: user._id, role: user.role },
    config.jwt.secret,
    { expiresIn: '1h' }
);

const api = async (method, path, { token, data, params } = {}) => axios({
    method,
    url: `${baseURL}${path}`,
    data,
    params,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    validateStatus: () => true,
    proxy: false,
});

const applicationPayload = (overrides = {}) => ({
    businessName: 'Oscar Partner Store',
    businessType: BUSINESS_TYPES.STORE,
    country: 'Egypt',
    city: 'Cairo',
    expectedMonthlyVolume: '2500',
    experienceSummary: 'We already serve gaming customers and need reseller pricing.',
    salesChannels: ['ONLINE', 'SOCIAL'],
    targetMarkets: ['Egypt'],
    contactPhone: '+201001112223',
    preferredContactMethod: 'WHATSAPP',
    ...overrides,
});

const waitFor = async (predicate, timeoutMs = 1000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = await predicate();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return predicate();
};

beforeAll(async () => {
    await connectTestDB();
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseURL = `http://127.0.0.1:${server.address().port}/api`;
});

afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await disconnectTestDB();
});

beforeEach(async () => {
    await clearCollections();
    resellerService.__setResellerApplicationTestHooks({});
});

afterEach(() => {
    resellerService.__setResellerApplicationTestHooks({});
});

describe('Phase 3A reseller application model and user APIs', () => {
    test('model defaults to PENDING, enforces unique number, unique idempotency key, and one pending application per user', async () => {
        const group = await createGroup();
        const user = await createCustomer({ groupId: group._id });
        const base = {
            userId: user._id,
            applicationNumber: 'RSA-2026-MODEL1',
            businessName: 'Model Store',
            businessType: BUSINESS_TYPES.STORE,
            country: 'Egypt',
            city: 'Cairo',
            expectedMonthlyVolume: '1000.50',
            experienceSummary: 'A valid reseller application model test payload.',
            salesChannels: ['ONLINE'],
            targetMarkets: ['Egypt'],
            contactPhone: '+201000000000',
            idempotencyKey: 'model-idempotency-1',
        };

        const created = await ResellerApplication.create(base);
        expect(created.status).toBe(RESELLER_APPLICATION_STATUS.PENDING);
        expect(created.expectedMonthlyVolume).toBe('1000.50');

        await expect(ResellerApplication.create({ ...base, applicationNumber: 'RSA-2026-MODEL2', idempotencyKey: 'model-idempotency-2' }))
            .rejects.toMatchObject({ code: 11000 });
        await expect(ResellerApplication.create({ ...base, userId: new mongoose.Types.ObjectId(), applicationNumber: 'RSA-2026-MODEL1', idempotencyKey: 'model-idempotency-3' }))
            .rejects.toMatchObject({ code: 11000 });
        await expect(ResellerApplication.create({ ...base, userId: new mongoose.Types.ObjectId(), applicationNumber: 'RSA-2026-MODEL3', idempotencyKey: 'model-idempotency-1' }))
            .rejects.toMatchObject({ code: 11000 });
    });

    test('authenticated active user submits one pending application and reads current/history safely', async () => {
        const group = await createGroup();
        const user = await createCustomer({ groupId: group._id });
        const token = tokenFor(user);

        const submit = await api('post', '/reseller-applications/me', { token, data: applicationPayload() });
        expect(submit.status).toBe(201);
        expect(submit.data.data.application.status).toBe(RESELLER_APPLICATION_STATUS.PENDING);
        expect(submit.data.data.application.applicationNumber).toMatch(/^RSA-/);

        const fresh = await User.findById(user._id).lean();
        expect(fresh.resellerStatus).toBe(RESELLER_STATUS.PENDING);

        const current = await api('get', '/reseller-applications/me/current', { token });
        expect(current.status).toBe(200);
        expect(current.data.data.resellerStatus).toBe(RESELLER_STATUS.PENDING);
        expect(current.data.data.application.reviewer).toBeUndefined();

        const history = await api('get', '/reseller-applications/me/history', { token, params: { page: 1, limit: 5 } });
        expect(history.status).toBe(200);
        expect(history.data.data.items).toHaveLength(1);
        expect(history.data.data.pagination.total).toBe(1);
    });

    test('duplicate identical submission returns existing pending, while different payload conflicts', async () => {
        const group = await createGroup();
        const user = await createCustomer({ groupId: group._id });

        const first = await resellerService.submitApplication(user._id, applicationPayload());
        const repeated = await resellerService.submitApplication(user._id, applicationPayload());
        expect(String(repeated._id)).toBe(String(first._id));
        expect(await ResellerApplication.countDocuments({ userId: user._id })).toBe(1);

        await expect(resellerService.submitApplication(user._id, applicationPayload({ city: 'Giza' })))
            .rejects.toMatchObject({ statusCode: 409 });
    });

    test('concurrent submissions produce one pending application and no reseller auth role', async () => {
        const group = await createGroup();
        const user = await createCustomer({ groupId: group._id });

        const results = await Promise.allSettled([
            resellerService.submitApplication(user._id, applicationPayload()),
            resellerService.submitApplication(user._id, applicationPayload()),
        ]);

        expect(await ResellerApplication.countDocuments({ userId: user._id, status: RESELLER_APPLICATION_STATUS.PENDING })).toBe(1);
        expect(Object.values(ROLES)).not.toContain('RESELLER');
        expect(Object.values(ROLES)).not.toContain('SUB_AGENT');
        expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
    });

    test('inactive users and client-supplied state fields cannot submit', async () => {
        const group = await createGroup();
        const inactive = await createCustomer({ groupId: group._id, status: USER_STATUS.REJECTED });
        const active = await createCustomer({ groupId: group._id });

        await expect(resellerService.submitApplication(inactive._id, applicationPayload()))
            .rejects.toMatchObject({ code: 'ACCOUNT_INACTIVE' });

        const token = tokenFor(active);
        const response = await api('post', '/reseller-applications/me', {
            token,
            data: {
                ...applicationPayload(),
                status: 'APPROVED',
                reviewedBy: new mongoose.Types.ObjectId().toString(),
                assignedGroupId: group._id.toString(),
            },
        });
        expect(response.status).toBe(201);
        const appDoc = await ResellerApplication.findById(response.data.data.application.id).lean();
        expect(appDoc.status).toBe(RESELLER_APPLICATION_STATUS.PENDING);
        expect(appDoc.reviewedBy).toBeNull();
        expect(appDoc.assignedGroupId).toBeNull();
    });
});

describe('Phase 3A admin review workflow', () => {
    test('admin list/details are permission protected and privacy-safe', async () => {
        const group = await createGroup();
        const customer = await createCustomer({ groupId: group._id, email: 'reseller@example.com' });
        const supervisor = await createAdmin({ groupId: group._id, role: ROLES.SUPERVISOR, permissions: [] });
        const permitted = await createAdmin({ groupId: group._id, role: ROLES.SUPERVISOR, permissions: ['MANAGE_USERS'] });
        await resellerService.submitApplication(customer._id, applicationPayload({ businessName: 'Searchable Store' }));

        const denied = await api('get', '/admin/reseller-applications', { token: tokenFor(supervisor) });
        expect(denied.status).toBe(403);

        const listed = await api('get', '/admin/reseller-applications', {
            token: tokenFor(permitted),
            params: { search: 'Searchable', status: 'PENDING' },
        });
        expect(listed.status).toBe(200);
        expect(listed.data.data.items).toHaveLength(1);
        expect(listed.data.data.items[0].user.emailMasked).toBe('r***@example.com');
        expect(listed.data.data.items[0].user.email).toBeUndefined();
    });

    test('approval atomically sets application APPROVED, user commercial state, and assigned pricing group', async () => {
        const defaultGroup = await createGroup({ name: 'Default', percentage: 5, isDefault: true });
        const resellerGroup = await createGroup({ name: 'Reseller', percentage: 2 });
        const customer = await createCustomer({ groupId: defaultGroup._id });
        const admin = await createAdmin({ groupId: defaultGroup._id });
        const appDoc = await resellerService.submitApplication(customer._id, applicationPayload());

        await resellerService.approveApplication(appDoc._id, admin._id, { assignedGroupId: resellerGroup._id });

        const [freshApp, freshUser] = await Promise.all([
            ResellerApplication.findById(appDoc._id).lean(),
            User.findById(customer._id).lean(),
        ]);
        expect(freshApp.status).toBe(RESELLER_APPLICATION_STATUS.APPROVED);
        expect(String(freshApp.previousGroupId)).toBe(String(defaultGroup._id));
        expect(String(freshApp.assignedGroupId)).toBe(String(resellerGroup._id));
        expect(freshUser.resellerStatus).toBe(RESELLER_STATUS.APPROVED);
        expect(String(freshUser.groupId)).toBe(String(resellerGroup._id));
        expect(String(freshUser.resellerGroupId)).toBe(String(resellerGroup._id));
    });

    test('inactive group approval fails and rolls back application and user', async () => {
        const defaultGroup = await createGroup({ isDefault: true });
        const inactiveGroup = await createGroup({ isActive: false });
        const customer = await createCustomer({ groupId: defaultGroup._id });
        const admin = await createAdmin({ groupId: defaultGroup._id });
        const appDoc = await resellerService.submitApplication(customer._id, applicationPayload());

        await expect(resellerService.approveApplication(appDoc._id, admin._id, { assignedGroupId: inactiveGroup._id }))
            .rejects.toMatchObject({ code: 'GROUP_INACTIVE' });

        const [freshApp, freshUser] = await Promise.all([
            ResellerApplication.findById(appDoc._id).lean(),
            User.findById(customer._id).lean(),
        ]);
        expect(freshApp.status).toBe(RESELLER_APPLICATION_STATUS.PENDING);
        expect(freshUser.resellerStatus).toBe(RESELLER_STATUS.PENDING);
        expect(String(freshUser.groupId)).toBe(String(defaultGroup._id));
    });

    test('rejection stores safe reason, sets user REJECTED, and leaves group unchanged', async () => {
        const group = await createGroup();
        const customer = await createCustomer({ groupId: group._id });
        const admin = await createAdmin({ groupId: group._id });
        const appDoc = await resellerService.submitApplication(customer._id, applicationPayload());

        await resellerService.rejectApplication(appDoc._id, admin._id, { rejectionReason: 'Insufficient commercial activity.' });

        const [freshApp, freshUser] = await Promise.all([
            ResellerApplication.findById(appDoc._id).lean(),
            User.findById(customer._id).lean(),
        ]);
        expect(freshApp.status).toBe(RESELLER_APPLICATION_STATUS.REJECTED);
        expect(freshApp.rejectionReason).toBe('Insufficient commercial activity.');
        expect(freshUser.resellerStatus).toBe(RESELLER_STATUS.REJECTED);
        expect(String(freshUser.groupId)).toBe(String(group._id));
    });

    test('suspension restores previous Group and reactivation restores reseller group or replacement', async () => {
        const previousGroup = await createGroup({ name: 'Previous Group', percentage: 8, isDefault: true });
        const resellerGroup = await createGroup({ name: 'Reseller', percentage: 1 });
        const replacementGroup = await createGroup({ name: 'Replacement Reseller', percentage: 3 });
        const customer = await createCustomer({ groupId: previousGroup._id });
        const admin = await createAdmin({ groupId: previousGroup._id });
        const appDoc = await resellerService.submitApplication(customer._id, applicationPayload());
        const approved = await resellerService.approveApplication(appDoc._id, admin._id, { assignedGroupId: resellerGroup._id });

        await resellerService.suspendApplication(approved._id, admin._id, { suspensionReason: 'Paused commercial access.' });
        let freshUser = await User.findById(customer._id).lean();
        expect(freshUser.resellerStatus).toBe(RESELLER_STATUS.SUSPENDED);
        expect(String(freshUser.groupId)).toBe(String(previousGroup._id));

        await Group.updateOne({ _id: resellerGroup._id }, { $set: { isActive: false } });
        await expect(resellerService.reactivateApplication(approved._id, admin._id, {}))
            .rejects.toMatchObject({ code: 'GROUP_INACTIVE' });

        await resellerService.reactivateApplication(approved._id, admin._id, { assignedGroupId: replacementGroup._id });
        freshUser = await User.findById(customer._id).lean();
        expect(freshUser.resellerStatus).toBe(RESELLER_STATUS.APPROVED);
        expect(String(freshUser.groupId)).toBe(String(replacementGroup._id));
    });

    test('approve versus reject concurrency has one winner', async () => {
        const group = await createGroup({ isDefault: true });
        const resellerGroup = await createGroup({ name: 'Concurrent Reseller', percentage: 2 });
        const customer = await createCustomer({ groupId: group._id });
        const admin = await createAdmin({ groupId: group._id });
        const appDoc = await resellerService.submitApplication(customer._id, applicationPayload());

        await Promise.allSettled([
            resellerService.approveApplication(appDoc._id, admin._id, { assignedGroupId: resellerGroup._id }),
            resellerService.rejectApplication(appDoc._id, admin._id, { rejectionReason: 'Concurrent rejection.' }),
        ]);

        const freshApp = await ResellerApplication.findById(appDoc._id).lean();
        expect([RESELLER_APPLICATION_STATUS.APPROVED, RESELLER_APPLICATION_STATUS.REJECTED]).toContain(freshApp.status);
        expect(freshApp.status).not.toBe(RESELLER_APPLICATION_STATUS.PENDING);
    });
});

describe('Phase 3A retry, side effects, and non-regression', () => {
    test('transient retries are bounded and side effects occur once after success', async () => {
        const group = await createGroup();
        const customer = await createCustomer({ groupId: group._id });
        let attempts = 0;
        resellerService.__setResellerApplicationTestHooks({
            transactionAttemptStarted: async () => {
                attempts += 1;
                if (attempts === 1) {
                    const err = new Error('transient');
                    err.errorLabels = ['TransientTransactionError'];
                    throw err;
                }
            },
        });

        const application = await resellerService.submitApplication(customer._id, applicationPayload());
        expect(application.status).toBe(RESELLER_APPLICATION_STATUS.PENDING);
        expect(attempts).toBe(2);
        expect(attempts).toBeLessThanOrEqual(resellerService.MAX_RESELLER_TRANSACTION_ATTEMPTS);

        await waitFor(() => AuditLog.countDocuments({ action: RESELLER_APPLICATION_ACTIONS.SUBMITTED }));
        expect(await AuditLog.countDocuments({ action: RESELLER_APPLICATION_ACTIONS.SUBMITTED })).toBe(1);
    });

    test('transaction failure rolls back application/user state and emits no post-commit effects', async () => {
        const group = await createGroup();
        const customer = await createCustomer({ groupId: group._id });
        resellerService.__setResellerApplicationTestHooks({
            afterApplicationCreated: async () => {
                throw new Error('forced rollback');
            },
        });

        await expect(resellerService.submitApplication(customer._id, applicationPayload()))
            .rejects.toThrow('forced rollback');
        expect(await ResellerApplication.countDocuments({ userId: customer._id })).toBe(0);
        expect((await User.findById(customer._id).lean()).resellerStatus).toBe(RESELLER_STATUS.NONE);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(await AuditLog.countDocuments({ action: RESELLER_APPLICATION_ACTIONS.SUBMITTED })).toBe(0);
        expect(await Notification.countDocuments({ source: 'RESELLER' })).toBe(0);
    });

    test('reseller workflow does not mutate referral attribution, commissions, payouts, or auth role', async () => {
        const group = await createGroup({ isDefault: true });
        const resellerGroup = await createGroup({ name: 'Commercial', percentage: 1 });
        const referrer = await createCustomer({ groupId: group._id });
        const customer = await createCustomer({
            groupId: group._id,
            referredBy: referrer._id,
            referredAt: new Date('2026-01-01T00:00:00.000Z'),
            referralSource: REFERRAL_SOURCE.EMAIL_REGISTRATION,
        });
        const admin = await createAdmin({ groupId: group._id });
        const commission = await ReferralCommission.create({
            referrerId: referrer._id,
            referredUserId: customer._id,
            depositId: new mongoose.Types.ObjectId(),
            walletTransactionId: new mongoose.Types.ObjectId(),
            sourceAmount: '100.00',
            sourceCurrency: 'USD',
            sourceExchangeRate: '1',
            sourceAmountUsd: '100.00',
            commissionRatePercent: '5',
            commissionAmountUsd: '5.00',
            commissionCurrency: 'USD',
            status: COMMISSION_STATUS.AVAILABLE,
            availableAt: new Date(),
            referralSource: REFERRAL_SOURCE.EMAIL_REGISTRATION,
            referredAt: customer.referredAt,
            idempotencyKey: `phase3a:${new mongoose.Types.ObjectId()}`,
        });
        const payout = await ReferralPayoutRequest.create({
            referrerId: referrer._id,
            commissionIds: [commission._id],
            amountUsd: '5.00',
            method: PAYOUT_METHOD.MANUAL,
            idempotencyKey: `phase3a:payout:${new mongoose.Types.ObjectId()}`,
            requestSnapshot: { commissionCount: 1, amountUsd: '5.00', commissionIds: [commission._id] },
        });

        const appDoc = await resellerService.submitApplication(customer._id, applicationPayload());
        await resellerService.approveApplication(appDoc._id, admin._id, { assignedGroupId: resellerGroup._id });

        const freshUser = await User.findById(customer._id).select('+referredBy +referredAt +referralSource').lean();
        expect(String(freshUser.referredBy)).toBe(String(referrer._id));
        expect(freshUser.role).toBe(ROLES.CUSTOMER);
        expect(await ReferralCommission.findById(commission._id).lean()).toMatchObject({ status: COMMISSION_STATUS.AVAILABLE });
        expect(await ReferralPayoutRequest.findById(payout._id).lean()).toMatchObject({ amountUsd: '5.00' });
    });
});

describe('Phase 3A reseller preflight classifier', () => {
    test('classifies major healthy and blocking states without writes', async () => {
        const defaultGroup = { _id: new mongoose.Types.ObjectId(), isDefault: true, isActive: true };
        const resellerGroup = { _id: new mongoose.Types.ObjectId(), isActive: true, deletedAt: null };
        const userId = new mongoose.Types.ObjectId();
        expect(classifyResellerApplicationState({
            application: { status: RESELLER_APPLICATION_STATUS.PENDING, userId },
            user: { resellerStatus: RESELLER_STATUS.PENDING },
            pendingCount: 1,
        })).toBe(RESELLER_RECONCILIATION_CODES.HEALTHY_PENDING);
        expect(classifyResellerApplicationState({
            application: { status: RESELLER_APPLICATION_STATUS.APPROVED, userId, assignedGroupId: resellerGroup._id },
            user: { resellerStatus: RESELLER_STATUS.APPROVED, groupId: resellerGroup._id },
            assignedGroup: resellerGroup,
        })).toBe(RESELLER_RECONCILIATION_CODES.HEALTHY_APPROVED);
        expect(classifyResellerApplicationState({
            application: { status: RESELLER_APPLICATION_STATUS.SUSPENDED, userId },
            user: { resellerStatus: RESELLER_STATUS.SUSPENDED, groupId: defaultGroup._id },
            defaultGroup,
        })).toBe(RESELLER_RECONCILIATION_CODES.HEALTHY_SUSPENDED);
        expect(classifyResellerApplicationState({
            application: { status: RESELLER_APPLICATION_STATUS.PENDING, userId },
            user: { resellerStatus: RESELLER_STATUS.APPROVED },
            pendingCount: 1,
        })).toBe(RESELLER_RECONCILIATION_CODES.PENDING_WITH_APPROVED_USER);
        expect(classifyResellerApplicationState({
            application: { status: RESELLER_APPLICATION_STATUS.APPROVED, userId, assignedGroupId: resellerGroup._id },
            user: { resellerStatus: RESELLER_STATUS.APPROVED, groupId: resellerGroup._id },
            assignedGroup: { ...resellerGroup, isActive: false },
        })).toBe(RESELLER_RECONCILIATION_CODES.APPROVED_WITH_INACTIVE_GROUP);
    });
});
