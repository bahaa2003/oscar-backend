'use strict';

require('dotenv').config();

const app = require('./app');
const config = require('./config/config');
const connectDB = require('./config/database');
const fulfillmentJob = require('./modules/orders/fulfillmentJob');
const orderFulfillmentService = require('./modules/orders/orderFulfillment.service');
const syncProvidersJob = require('./modules/providers/syncProvidersJob');
const whatsappService = require('./modules/whatsapp/whatsapp.service');
const depositService = require('./modules/deposits/deposit.service');
const walletOperationService = require('./modules/wallet/walletOperation.service');
const auditOutboxService = require('./modules/audit/auditOutbox.service');


const startServer = async () => {
    try {
        // 1. Connect to MongoDB first
        await connectDB();

        // Fail closed before accepting money operations if their durable
        // idempotency and audit event indexes are not ready.
        await walletOperationService.ensureWalletOperationIndexesReady();
        await auditOutboxService.ensureAuditOutboxIndexesReady();
        const walletIndex = await depositService.ensureDepositIdempotencyIndexReady();
        if (!walletIndex.ready) throw new Error(`Wallet idempotency index unavailable: ${walletIndex.reason || 'unknown reason'}`);
        await depositService.assertDepositCreditGuardIndexesReady();

        // Complete any standalone-Mongo deposit approvals interrupted after their wallet claim.
        await depositService.resumePendingDepositApprovals();
        await walletOperationService.recoverPendingWalletOperations();
        await auditOutboxService.processAuditOutboxBatch({ limit: 500 });

        // 2. Then start listening
        const server = app.listen(config.port, () => {
            console.log('');
            console.log('═══════════════════════════════════════════════════════');
            console.log(`  🚀  Digital Products Platform`);
            console.log(`  🌍  Environment : ${config.env}`);
            console.log(`  📡  Port        : ${config.port}`);
            console.log(`  🔗  Base URL    : http://localhost:${config.port}/api`);
            console.log('═══════════════════════════════════════════════════════');
            console.log('');
        });

        // 3. Start background cron jobs (skipped in test env)
        fulfillmentJob.start();    // every minute  — polls PROCESSING order statuses
        syncProvidersJob.start();  // every 6 hours — syncs provider product catalogues
        depositService.startDepositRecoveryWorker(); // resumes expired standalone deposit-credit leases
        walletOperationService.startWalletOperationRecoveryWorker();
        auditOutboxService.startAuditOutboxWorker();
        whatsappService.initializeWhatsAppClient().catch((err) => {
            console.error('[WhatsApp] startup initialization failed:', err.message);
        });
        if (typeof process.send === 'function') {
            process.send('ready');
        }

        // ── Graceful Shutdown ─────────────────────────────────────────────────────
        const gracefulShutdown = async (signal) => {
            console.log(`\n⚠️  Received ${signal}. Shutting down gracefully...`);

            // Stop scheduled work, then stop accepting requests before draining.
            fulfillmentJob.stop();
            syncProvidersJob.stop();
            const workerDrain = Promise.all([
                depositService.stopDepositRecoveryWorker({ timeoutMs: 8_000 }),
                walletOperationService.stopWalletOperationRecoveryWorker({ timeoutMs: 8_000 }),
            ]);
            whatsappService.destroyWhatsAppClient().catch((err) => {
                console.warn('[WhatsApp] shutdown cleanup failed:', err.message);
            });

            server.close(async () => {
                console.log('✅ HTTP server closed.');
                await workerDrain;
                const fulfillmentDrain = await orderFulfillmentService.drainOrderExecutions({ timeoutMs: 8_000 });
                if (!fulfillmentDrain.drained) {
                    console.warn(`[Fulfillment] ${fulfillmentDrain.pending} order task(s) remain active at shutdown; their wallet operations remain resumable.`);
                }
                await Promise.all([
                    walletOperationService.recoverPendingWalletOperations({ limit: 100 }).catch((err) => console.warn('[Wallet] final recovery pass failed:', err.message)),
                    auditOutboxService.stopAuditOutboxWorker({ timeoutMs: 8_000 }),
                ]);
                const mongoose = require('mongoose');
                await mongoose.connection.close();
                console.log('✅ MongoDB connection closed.');
                process.exit(0);
            });

            // Force exit after 10s if graceful shutdown stalls
            setTimeout(() => {
                console.error('❌ Graceful shutdown timed out. Forcing exit.');
                process.exit(1);
            }, 10_000);
        };

        process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
        process.on('SIGINT', () => gracefulShutdown('SIGINT'));

        // ── Unhandled Rejections / Exceptions ─────────────────────────────────────
        process.on('unhandledRejection', (reason) => {
            console.error('💥 Unhandled Promise Rejection:', reason);
            gracefulShutdown('unhandledRejection');
        });

        process.on('uncaughtException', (error) => {
            console.error('💥 Uncaught Exception:', error);
            process.exit(1);
        });

        return server;
    } catch (error) {
        console.error('❌ Failed to start server:', error.message);
        try {
            await require('mongoose').disconnect();
        } catch (disconnectError) {
            console.error('❌ MongoDB cleanup after startup failure failed:', disconnectError.message);
        }
        process.exitCode = 1;
    }
};

startServer();
