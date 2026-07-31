'use strict';

jest.mock('../modules/notifications/notification.service', () => ({
    notifyNewTargetOrder: jest.fn(),
    notifyTargetApproved: jest.fn(),
    notifyTargetRejected: jest.fn(),
}));

const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createCustomerWithGroup,
    createAdmin,
} = require('./testHelpers');
const targetSvc = require('../modules/targets/target.service');
const { TargetOrder, TARGET_ORDER_STATUS } = require('../modules/targets/target.model');
const { AuditLog } = require('../modules/audit/audit.model');
const { TARGET_ORDER_ACTIONS, ACTOR_ROLES } = require('../modules/audit/audit.constants');

const flushAudit = () => new Promise((resolve) => setTimeout(resolve, 100));

describe('Target app purchasing', () => {
    beforeAll(connectTestDB);
    afterAll(disconnectTestDB);
    beforeEach(clearCollections);

    test('creates target orders from an active app and snapshots app pricing', async () => {
        const { customer } = await createCustomerWithGroup();
        const app = await targetSvc.createTargetApp({
            name: 'TikTok Coins',
            unitPrice: 1.25,
            allowedPaymentMethods: ['Vodafone Cash', 'InstaPay'],
            image: 'uploads/target-apps/tiktok.png',
        });

        const order = await targetSvc.createTargetOrder({
            userId: customer._id,
            appId: app._id,
            coinAmount: 10,
            senderId: 'sender-123',
            transferNumber: '01000000000',
            paymentMethod: 'InstaPay',
            screenshotProof: 'uploads/targets/proof.png',
        });

        expect(order.appId.toString()).toBe(app._id.toString());
        expect(order.appNameSnapshot).toBe('TikTok Coins');
        expect(order.unitPriceSnapshot).toBe(1.25);
        expect(order.totalPrice).toBe(12.5);
        expect(order.transferNumber).toBe('01000000000');
        expect(order.paymentMethod).toBe('InstaPay');
    });

    test('rejects payment methods not allowed by the selected app', async () => {
        const { customer } = await createCustomerWithGroup();
        const app = await targetSvc.createTargetApp({
            name: 'PUBG Mobile',
            unitPrice: 2,
            allowedPaymentMethods: ['Binance'],
        });

        await expect(targetSvc.createTargetOrder({
            userId: customer._id,
            appId: app._id,
            coinAmount: 5,
            senderId: 'sender-456',
            transferNumber: '01000000001',
            paymentMethod: 'Vodafone Cash',
            screenshotProof: 'uploads/targets/proof.png',
        })).rejects.toMatchObject({ code: 'PAYMENT_METHOD_NOT_ALLOWED' });
    });

    test('deactivates target apps and hides them from customer app lists', async () => {
        const activeApp = await targetSvc.createTargetApp({
            name: 'Active App',
            unitPrice: 1,
            allowedPaymentMethods: ['Vodafone Cash'],
        });
        const inactiveApp = await targetSvc.createTargetApp({
            name: 'Inactive App',
            unitPrice: 1,
            allowedPaymentMethods: ['Vodafone Cash'],
        });

        await targetSvc.deactivateTargetApp(inactiveApp._id);

        const customerApps = await targetSvc.listTargetApps({ includeInactive: false });
        const adminApps = await targetSvc.listTargetApps({ includeInactive: true });

        expect(customerApps.map((app) => app._id.toString())).toEqual([activeApp._id.toString()]);
        expect(adminApps).toHaveLength(2);
    });

    test('keeps admin review compare-and-swap behavior', async () => {
        const { customer } = await createCustomerWithGroup();
        const admin = await createAdmin();
        const app = await targetSvc.createTargetApp({
            name: 'TikTok Coins',
            unitPrice: 1,
            allowedPaymentMethods: ['Vodafone Cash'],
        });
        const order = await targetSvc.createTargetOrder({
            userId: customer._id,
            appId: app._id,
            coinAmount: 10,
            senderId: 'sender-789',
            transferNumber: '01000000002',
            paymentMethod: 'Vodafone Cash',
            screenshotProof: 'uploads/targets/proof.png',
        });

        await targetSvc.approveTargetOrder(order._id, admin._id);
        await expect(targetSvc.rejectTargetOrder(order._id, admin._id)).rejects.toMatchObject({
            code: 'TARGET_ORDER_ALREADY_APPROVED',
        });

        const reviewed = await TargetOrder.findById(order._id);
        expect(reviewed.status).toBe(TARGET_ORDER_STATUS.APPROVED);
    });

    test('writes target approval/rejection audit logs with supervisor actor role', async () => {
        const { customer } = await createCustomerWithGroup();
        const supervisor = await createAdmin({ role: ACTOR_ROLES.SUPERVISOR });
        const app = await targetSvc.createTargetApp({
            name: 'Live Coins',
            unitPrice: 1.5,
            allowedPaymentMethods: ['Vodafone Cash'],
        });

        const approvalOrder = await targetSvc.createTargetOrder({
            userId: customer._id,
            appId: app._id,
            coinAmount: 8,
            senderId: 'approve-1',
            transferNumber: '01000000003',
            paymentMethod: 'Vodafone Cash',
            screenshotProof: 'uploads/targets/proof-approve.png',
        });

        await targetSvc.approveTargetOrder(
            approvalOrder._id,
            supervisor._id,
            { actorId: supervisor._id, actorRole: ACTOR_ROLES.SUPERVISOR }
        );

        const rejectionOrder = await targetSvc.createTargetOrder({
            userId: customer._id,
            appId: app._id,
            coinAmount: 6,
            senderId: 'reject-1',
            transferNumber: '01000000004',
            paymentMethod: 'Vodafone Cash',
            screenshotProof: 'uploads/targets/proof-reject.png',
        });

        await targetSvc.rejectTargetOrder(
            rejectionOrder._id,
            supervisor._id,
            'Invalid transfer screenshot',
            { actorId: supervisor._id, actorRole: ACTOR_ROLES.SUPERVISOR }
        );

        await flushAudit();

        const [approveLog, rejectLog] = await Promise.all([
            AuditLog.findOne({
                action: TARGET_ORDER_ACTIONS.APPROVED,
                entityId: approvalOrder._id,
            }).lean(),
            AuditLog.findOne({
                action: TARGET_ORDER_ACTIONS.REJECTED,
                entityId: rejectionOrder._id,
            }).lean(),
        ]);

        expect(approveLog).not.toBeNull();
        expect(approveLog.actorId.toString()).toBe(supervisor._id.toString());
        expect(approveLog.actorRole).toBe(ACTOR_ROLES.SUPERVISOR);

        expect(rejectLog).not.toBeNull();
        expect(rejectLog.actorId.toString()).toBe(supervisor._id.toString());
        expect(rejectLog.actorRole).toBe(ACTOR_ROLES.SUPERVISOR);
    });
});
