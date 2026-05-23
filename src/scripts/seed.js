'use strict';

/**
 * Database Seeder
 * Creates seed data: groups, users, products, and target apps.
 *
 * Usage:
 *   node src/scripts/seed.js          -> seed
 *   node src/scripts/seed.js --clear  -> wipe all collections
 */

require('dotenv').config();

const mongoose = require('mongoose');
const config = require('../config/config');
const { User, ROLES, USER_STATUS } = require('../modules/users/user.model');
const Group = require('../modules/groups/group.model');
const { Product } = require('../modules/products/product.model');
const { WalletTransaction } = require('../modules/wallet/walletTransaction.model');
const { Order } = require('../modules/orders/order.model');
const { TargetApp } = require('../modules/targets/target.model');

const CLEAR_FLAG = process.argv.includes('--clear');

const seed = async () => {
    try {
        await mongoose.connect(config.db.uri);
        console.log('Connected to MongoDB');

        if (CLEAR_FLAG) {
            await Promise.all([
                User.deleteMany({}),
                Group.deleteMany({}),
                Product.deleteMany({}),
                Order.deleteMany({}),
                WalletTransaction.deleteMany({}),
                TargetApp.deleteMany({}),
            ]);
            console.log('All collections cleared.');
            process.exit(0);
        }

        // 1. Create Groups
        // Standard (0%) is the default / lowest tier.
        // Premium (15%) is the highest and is auto-assigned to new registrations.
        const standardGroup = await Group.findOneAndUpdate(
            { name: 'Standard' },
            { name: 'Standard', percentage: 0, isActive: true },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        const premiumGroup = await Group.findOneAndUpdate(
            { name: 'Premium' },
            { name: 'Premium', percentage: 15, isActive: true },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        console.log('Groups seeded:');
        console.log(`   Standard (0%) id: ${standardGroup._id}`);
        console.log(`   Premium (15%) id: ${premiumGroup._id}`);
        console.log('   New registrations will be auto-assigned: Premium (highest percentage)');

        // 2. Create Admin User
        // Admins are assigned the Standard group (lowest markup) by convention.
        const adminExists = await User.findOne({ email: 'admin@platform.com' });
        let admin;
        if (!adminExists) {
            admin = await User.create({
                name: 'Platform Admin',
                email: 'admin@platform.com',
                password: 'Admin@1234',
                role: ROLES.ADMIN,
                groupId: standardGroup._id,
                walletBalance: 0,
                creditLimit: 0,
            });
            console.log('Admin created: admin@platform.com / Admin@1234');
        } else {
            admin = adminExists;
            console.log(`Admin already exists (id: ${admin._id})`);
        }

        // 3. Create Supervisor User
        const supervisorPermissions = ['MANAGE_TARGETS', 'VIEW_USERS', 'MANAGE_DEPOSITS'];
        const supervisorExists = await User.findOne({ email: 'supervisor@platform.com' });
        let supervisor;
        if (!supervisorExists) {
            supervisor = await User.create({
                name: 'Operations Supervisor',
                email: 'supervisor@platform.com',
                password: 'Supervisor@1234',
                role: ROLES.SUPERVISOR,
                status: USER_STATUS.ACTIVE,
                verified: true,
                permissions: supervisorPermissions,
                groupId: standardGroup._id,
                walletBalance: 0,
                creditLimit: 0,
            });
            console.log('Supervisor created: supervisor@platform.com / Supervisor@1234');
        } else {
            supervisor = supervisorExists;
            supervisor.role = ROLES.SUPERVISOR;
            supervisor.status = USER_STATUS.ACTIVE;
            supervisor.verified = true;
            supervisor.permissions = supervisorPermissions;
            supervisor.groupId = standardGroup._id;
            await supervisor.save();
            console.log(`Supervisor already exists (id: ${supervisor._id})`);
        }
        console.log(`   Supervisor permissions: ${supervisor.permissions.join(', ')}`);

        // 4. Create Customer User
        const customerExists = await User.findOne({ email: 'customer@platform.com' });
        let customer;
        if (!customerExists) {
            customer = await User.create({
                name: 'Test Customer',
                email: 'customer@platform.com',
                password: 'Customer@1234',
                role: ROLES.CUSTOMER,
                groupId: standardGroup._id,
                walletBalance: 500,
                creditLimit: 200,
            });
            console.log('Customer created: customer@platform.com / Customer@1234');
            console.log('   walletBalance: $500 | creditLimit: $200 | group: Standard');
        } else {
            customer = customerExists;
            console.log(`Customer already exists (id: ${customer._id})`);
        }

        // 5. Create Sample Products
        const products = [
            { name: 'Basic Plan - 30 Days', basePrice: 9.99, minQty: 1, maxQty: 50 },
            { name: 'Pro Plan - 30 Days', basePrice: 29.99, minQty: 1, maxQty: 20 },
            { name: 'API Credits Bundle', basePrice: 4.99, minQty: 1, maxQty: 100 },
        ];

        for (const p of products) {
            await Product.findOneAndUpdate(
                { name: p.name },
                p,
                { upsert: true, new: true }
            );
        }

        console.log(`${products.length} products seeded.`);

        // 6. Create Target Apps
        // Target apps are refreshed on every seed run so frontend fixtures stay predictable.
        await TargetApp.deleteMany({});

        const targetApps = [
            {
                name: 'TikTok Coins',
                unitPrice: 0.92,
                image: 'uploads/target-apps/tiktok-coins.png',
                allowedPaymentMethods: ['InstaPay', 'Binance'],
                isActive: true,
            },
            {
                name: 'PUBG Mobile',
                unitPrice: 1.35,
                image: 'uploads/target-apps/pubg-mobile.png',
                allowedPaymentMethods: ['Vodafone Cash', 'InstaPay', 'Binance'],
                isActive: true,
            },
            {
                name: 'Free Fire',
                unitPrice: 1.1,
                image: 'uploads/target-apps/free-fire.png',
                allowedPaymentMethods: ['Vodafone Cash', 'InstaPay'],
                isActive: true,
            },
        ];

        const createdTargetApps = await TargetApp.insertMany(targetApps);
        console.log(`${createdTargetApps.length} target apps seeded:`);
        createdTargetApps.forEach((app) => {
            console.log(`   ${app.name} | unitPrice: ${app.unitPrice} | methods: ${app.allowedPaymentMethods.join(', ')}`);
        });

        // Summary
        console.log('');
        console.log('===================================================');
        console.log('Seed complete. Test credentials:');
        console.log('ADMIN      -> admin@platform.com / Admin@1234');
        console.log('SUPERVISOR -> supervisor@platform.com / Supervisor@1234');
        console.log('CUSTOMER   -> customer@platform.com / Customer@1234');
        console.log('===================================================');

        process.exit(0);
    } catch (error) {
        console.error('Seeding failed:', error.message);
        console.error(error);
        process.exit(1);
    }
};

seed();
