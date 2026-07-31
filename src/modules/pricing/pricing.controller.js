'use strict';

const catchAsync = require('../../shared/utils/catchAsync');
const { sendSuccess } = require('../../shared/utils/apiResponse');
const {
    calculateOrderPricing,
    previewPriceForAdmin,
} = require('./commercialPricing.service');

const quoteForCurrentUser = catchAsync(async (req, res) => {
    const quote = await calculateOrderPricing({
        userId: req.user._id,
        items: req.body.items,
        currency: req.body.currency,
        rejectClientPricing: true,
    });

    sendSuccess(res, {
        items: quote.items.map((item) => ({
            productId: item.productId,
            quantity: item.quantity,
            unitPrice: item.finalUnitPrice,
            lineTotal: item.lineTotal,
            lineTotalUsd: item.lineTotalUsd,
            currency: item.currency,
            calculationVersion: item.calculationVersion,
        })),
        subtotal: quote.subtotal,
        total: quote.total,
        subtotalUsd: quote.subtotalUsd,
        totalUsd: quote.totalUsd,
        currency: quote.currency,
        pricingContext: {
            pricingType: quote.pricingContext.pricingType,
            effectiveGroupName: quote.pricingContext.effectiveGroup.name,
            calculationVersion: quote.calculationVersion,
        },
    }, 'Pricing quote calculated.');
});

const adminPreview = catchAsync(async (req, res) => {
    const preview = await previewPriceForAdmin({
        userId: req.query.userId,
        productId: req.query.productId,
        quantity: req.query.quantity || 1,
        currency: req.query.currency || null,
    });

    sendSuccess(res, { preview }, 'Pricing preview calculated.');
});

module.exports = {
    quoteForCurrentUser,
    adminPreview,
};
