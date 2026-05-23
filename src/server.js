'use strict';

require('dotenv').config();

const app = require('./app');
const config = require('./config/config');
const connectDB = require('./config/database');
const fulfillmentJob = require('./modules/orders/fulfillmentJob');
const syncProvidersJob = require('./modules/providers/syncProvidersJob');


const startServer = async () => {
    try {
        // 1. Connect to MongoDB first
        await connectDB();

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

        // ── Graceful Shutdown ─────────────────────────────────────────────────────
        const gracefulShutdown = (signal) => {
            console.log(`\n⚠️  Received ${signal}. Shutting down gracefully...`);

            // Stop both cron jobs before closing HTTP
            fulfillmentJob.stop();
            syncProvidersJob.stop();

            server.close(async () => {
                console.log('✅ HTTP server closed.');
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
        process.exit(1);
    }
};

startServer();
