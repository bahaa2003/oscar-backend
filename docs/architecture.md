# System Architecture

## Overview

The Digital Products Platform is a layered Node.js + Express + MongoDB backend. It manages a product catalogue sourced from external providers, sells those products to customers at marked-up prices, and drives order fulfillment through provider APIs.

---

## High-Level Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                         Client (Frontend / API consumer)           │
└─────────────────────────────┬──────────────────────────────────────┘
                              │ HTTPS
┌─────────────────────────────▼──────────────────────────────────────┐
│                     Express Application (app.js)                   │
│                                                                    │
│  Security: helmet, cors, JSON body 10kb limit                      │
│  Logging:  morgan (dev=colored, production=combined)               │
│  Auth:     JWT (authenticate middleware) + passport (Google OAuth) │
│                                                                    │
│  Route Hierarchy:                                                  │
│   /health              → health probe (no auth)                    │
│   /api/auth/*          → public auth routes                        │
│   /api/me/*            → user self-service panel                   │
│   /api/orders/*        → order endpoints (customer + admin)        │
│   /api/products/*      → public product catalogue                  │
│   /api/wallet/*        → wallet history                            │
│   /api/deposits/*      → deposit requests                          │
│   /api/providers/*     → provider management                       │
│   /api/audit/*         → audit log queries                         │
│   /api/groups/*        → pricing group management                  │
│   /api/users/*         → user management                           │
│   /api/admin/*         → admin dashboard APIs                      │
│   /api/admin/catalog/* → provider catalog + product management     │
│   /api/admin/currencies/* → currency rate management               │
│   /uploads/*           → static file serving (deposit screenshots) │
└────────┬───────────────────────────────────────────────────────────┘
         │
┌────────▼────────────────────────────────────────────────────────────┐
│                       Middleware Stack                              │
│                                                                    │
│  authenticate      — verify JWT, attach req.user                   │
│  authorize(role)   — check req.user.role matches required role     │
│  requireActiveUser — verify req.user.status === ACTIVE             │
│  validate          — run express-validator result chain            │
│  upload            — multer (single file, /uploads/ destination)   │
│  catchAsync        — wraps async handlers, forwards errors         │
│  globalErrorHandler— final error → structured JSON response        │
└────────┬────────────────────────────────────────────────────────────┘
         │
┌────────▼────────────────────────────────────────────────────────────┐
│                      Business Layer (Services)                     │
│                                                                    │
│  auth.service           order.service        pricing.service       │
│  wallet.service         orderFulfillment.service                   │
│  orderPolling.service   deposit.service      product.service       │
│  providerCatalog.service                     audit.service         │
│  currency.service       group.service        admin.*.service       │
└────────┬────────────────────────────────────────────────────────────┘
         │
┌────────▼────────────────────────────────────────────────────────────┐
│                      Data Layer (Mongoose / MongoDB)                │
│                                                                    │
│  User            — accounts, wallets, groups, currency             │
│  Group           — pricing tiers with markup percentages           │
│  Product         — curated catalogue (orderFields, providerMapping)│
│  ProviderProduct — raw synced inventory (internal only)            │
│  Provider        — external API config + credentials               │
│  Order           — placed orders with full pricing/field snapshots │
│  WalletTransaction — immutable balance change records              │
│  DepositRequest  — wallet funding requests                         │
│  Currency        — exchange rates (market + platform)              │
│  AuditLog        — immutable event trail                           │
│  Setting         — key-value platform configuration                │
└────────┬────────────────────────────────────────────────────────────┘
         │
┌────────▼────────────────────────────────────────────────────────────┐
│              Background Jobs (cron, skipped in test env)           │
│                                                                    │
│  fulfillmentJob    — every 1 min, polls PROCESSING orders          │
│  syncProvidersJob  — every 6 hours, syncs provider catalogues      │
└────────┬────────────────────────────────────────────────────────────┘
         │
┌────────▼────────────────────────────────────────────────────────────┐
│                   Provider Adapter Layer                           │
│                                                                    │
│  adapter.factory          — slug/name → adapter resolution         │
│  BaseProviderAdapter      — abstract base with _validateDTO        │
│  RoyalCrownAdapter        — https://royal-croown.com               │
│  TorosfonAdapter          — https://torosfon.com                   │
│  AlkasrVipAdapter         — https://alkasr-vip.com                 │
│  MockProviderAdapter      — dev/test fallback                      │
└────────────────────────────────────────────────────────────────────┘
```

---

## Directory Structure

```
src/
├── app.js                     Express app factory
├── server.js                  Entry point: DB connect, listen, cron start
│
├── config/
│   ├── config.js              Centralized env-var access
│   ├── database.js            Mongoose connection
│   └── google.strategy.js     Passport Google OAuth 2.0 strategy
│
├── modules/
│   ├── admin/                 Admin dashboard APIs
│   │   ├── admin.routes.js    All /api/admin/* routes
│   │   ├── admin.catalog.routes.js  /api/admin/catalog + /admin/products
│   │   ├── admin.catalog.controller.js
│   │   ├── admin.users.controller.js
│   │   ├── admin.orders.controller.js
│   │   ├── admin.wallet.controller.js
│   │   ├── admin.providers.controller.js
│   │   ├── admin.settings.controller.js
│   │   ├── admin.validation.js
│   │   └── setting.model.js
│   │
│   ├── audit/                 Immutable event logging
│   │   ├── audit.model.js
│   │   ├── audit.service.js
│   │   ├── audit.constants.js
│   │   └── audit.routes.js
│   │
│   ├── auth/                  Authentication
│   │   ├── auth.routes.js
│   │   ├── auth.controller.js
│   │   ├── auth.service.js
│   │   └── auth.validation.js
│   │
│   ├── currency/              Exchange rate management
│   │   ├── currency.model.js
│   │   ├── currency.service.js
│   │   ├── currency.routes.js
│   │   └── exchangeRateSync.service.js
│   │
│   ├── deposits/              Wallet deposit requests
│   │   ├── deposit.model.js
│   │   ├── deposit.service.js
│   │   └── deposit.routes.js
│   │
│   ├── groups/                Pricing tier groups
│   │   ├── group.model.js
│   │   ├── group.service.js
│   │   └── group.routes.js
│   │
│   ├── me/                    User self-service panel
│   │   ├── me.routes.js
│   │   └── me.controller.js
│   │
│   ├── orders/                Order system
│   │   ├── order.model.js
│   │   ├── order.service.js
│   │   ├── order.controller.js
│   │   ├── order.routes.js
│   │   ├── order.validation.js
│   │   ├── orderFields.validator.js  ← dynamic field validation
│   │   ├── orderFulfillment.service.js
│   │   ├── orderPolling.service.js
│   │   ├── orderPolling.job.js
│   │   ├── fulfillmentJob.js
│   │   └── pricing.service.js
│   │
│   ├── products/              Platform product catalogue
│   │   ├── product.model.js   (includes orderFields + providerMapping)
│   │   ├── product.service.js
│   │   └── product.routes.js
│   │
│   ├── providers/             Provider integration
│   │   ├── provider.model.js
│   │   ├── providerProduct.model.js
│   │   ├── provider.routes.js
│   │   ├── providerCatalog.service.js
│   │   ├── syncProvidersJob.js
│   │   └── adapters/
│   │       ├── adapter.factory.js
│   │       ├── base.adapter.js
│   │       ├── royalCrown.adapter.js
│   │       ├── toros.adapter.js
│   │       ├── alkasr.adapter.js
│   │       └── mock.adapter.js
│   │
│   ├── users/                 User model + routes
│   │   ├── user.model.js
│   │   └── user.routes.js
│   │
│   └── wallet/                Wallet operations
│       ├── wallet.service.js
│       ├── wallet.routes.js
│       └── walletTransaction.model.js
│
├── shared/
│   ├── errors/
│   │   ├── AppError.js        Error class hierarchy
│   │   └── errorHandler.js    Global Express error handler
│   ├── middlewares/
│   │   ├── authenticate.js    JWT verification
│   │   ├── authorize.js       Role-based access control
│   │   ├── requireActiveUser.js
│   │   ├── upload.js          Multer file upload config
│   │   └── validate.js        express-validator result checker
│   └── utils/
│       ├── catchAsync.js      Async error propagation wrapper
│       └── apiResponse.js     Standardized JSON response helpers
│
└── tests/                     17 test suites, 583 tests
    ├── testHelpers.js
    ├── auth.test.js
    ├── activation.test.js
    ├── order.test.js
    ├── orderFields.test.js
    ├── orderFieldsExtended.test.js
    ├── fulfillment.test.js
    ├── orderPolling.test.js
    ├── deposit.test.js
    ├── catalog.test.js
    ├── provider.test.js
    ├── adapters.test.js
    ├── admin.test.js
    ├── audit.test.js
    ├── currency.test.js
    ├── pricing.test.js
    └── group.test.js
```

---

## Data Flow: Order Creation

```
HTTP Request
     │
     ▼
order.routes.js
     │  (authenticate, requireActiveUser, authorize('CUSTOMER'), validate)
     ▼
order.controller.js → createOrder()
     │  extract: productId, quantity, orderFieldsValues, idempotencyKey
     ▼
order.service.js → createOrder()
     │
     ├─1─ Product.findById → validate active + qty range
     │
     ├─2─ validateOrderFields(product.orderFields, orderFieldsValues)
     │       → { values, fieldsSnapshot }
     │
     ├─3─ calculateUserPrice(userId, product.basePrice)
     │       → { finalPrice, markupPercentage, groupId }
     │
     ├─4─ MongoDB session.startTransaction()
     │
     ├─5─ Idempotency check (userId + idempotencyKey unique index)
     │
     ├─6─ debitWalletAtomic({ userId, amount, session })
     │       → aggregation pipeline: walletBalance -= amount (atomic)
     │
     ├─7─ Order.create({ ...all fields, customerInput: { values, fieldsSnapshot } })
     │
     ├─8─ session.commitTransaction()
     │
     └─9─ if executionType === 'automatic':
              executeOrder(order._id, provider) [fire-and-forget]
                  │
                  ├─ applyProviderMapping(values, product.providerMapping)
                  ├─ provider.placeOrder({ externalProductId, quantity, ...mapped })
                  └─ handle response → update order status
```

---

## Middleware Stack (per request)

```
Request
  → helmet()              HTTP security headers
  → cors()                CORS policy
  → express.json()        Body parsing, 10kb limit
  → morgan()              Request logging (non-test)
  → passport.initialize() OAuth state (if Google configured)
  → [route middleware]    authenticate → authorize → requireActiveUser → validate
  → [route handler]       catchAsync(controller)
  → globalErrorHandler    Convert AppError to JSON response
```

---

## Error Class Hierarchy

```
Error
  └── AppError(message, statusCode, code)
        ├── ValidationError(message, errors[])     400 VALIDATION_ERROR
        ├── AuthenticationError(message)            401 AUTHENTICATION_ERROR
        ├── AuthorizationError(message)             403 AUTHORIZATION_ERROR
        ├── NotFoundError(resource)                 404 NOT_FOUND
        ├── ConflictError(message)                  409 CONFLICT
        ├── InsufficientFundsError(required, avail) 422 INSUFFICIENT_FUNDS
        └── BusinessRuleError(message, code)        422 BUSINESS_RULE_VIOLATION
                                                         (or custom code)
```

All `AppError` subclasses set `isOperational = true`. The global error handler sends structured JSON for operational errors and a generic 500 for unexpected ones.
