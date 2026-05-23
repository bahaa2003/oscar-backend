require('dotenv').config();
const mongoose = require('mongoose');

const { Order } = require('./src/modules/orders/order.model');
const { WalletTransaction } = require('./src/modules/wallet/walletTransaction.model');

async function fixWalletTransactions() {
    try {
        console.log('Connecting to database...');
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected.');

        // Find all orders
        console.log('Fetching orders...');
        const orders = await Order.find({}).select('_id userId createdAt').lean();
        console.log(`Found ${orders.length} orders.`);

        let updatedCount = 0;
        let notFoundCount = 0;

        for (const order of orders) {
            // Find a matching wallet transaction:
            // - type DEBIT
            // - same user
            // - reference is null
            // - created very close to the order (within 5 seconds before or after)
            const timeWindow = 5000; // 5 seconds
            
            const startRange = new Date(order.createdAt.getTime() - timeWindow);
            const endRange = new Date(order.createdAt.getTime() + timeWindow);

            const tx = await WalletTransaction.findOne({
                userId: order.userId,
                type: 'DEBIT',
                reference: null,
                createdAt: { $gte: startRange, $lte: endRange }
            });

            if (tx) {
                tx.reference = order._id;
                await tx.save();
                updatedCount++;
                if (updatedCount % 100 === 0) {
                    console.log(`Updated ${updatedCount} transactions...`);
                }
            } else {
                // It might already be fixed, or it's an order without a wallet deduction
                notFoundCount++;
            }
        }

        console.log(`\nFinished!`);
        console.log(`Updated: ${updatedCount}`);
        console.log(`Could not find unlinked transaction for ${notFoundCount} orders (likely already fixed).`);

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await mongoose.disconnect();
        console.log('Disconnected.');
    }
}

fixWalletTransactions();
