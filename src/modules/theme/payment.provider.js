'use strict';

const { AppError } = require('../../shared/errors/AppError');

// No verified electronic merchant integration exists in this repository.
// A future adapter must implement createCheckoutSession({ payerUserId, plan })
// and verifyWebhook({ rawBody, headers }), returning trusted provider facts.
// Only verified events may be passed to a transactional activation service.
const getPaymentProvider = () => null;

const requirePaymentProvider = () => {
    const provider = getPaymentProvider();
    if (!provider) throw new AppError(
        'Theme Customization Pro checkout is unavailable until the developer payment provider is configured.',
        503, 'PAYMENT_PROVIDER_UNAVAILABLE');
    return provider;
};

module.exports = { getPaymentProvider, requirePaymentProvider };
