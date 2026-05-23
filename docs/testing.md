# Testing Guide

## Overview

The platform has a comprehensive test suite covering every layer of the system: models, services, validators, fulfillment logic, wallet atomicity, order lifecycle, provider adapters, admin APIs, and the dynamic order fields system.

**Stats:** 17 test suites | 583 tests | 100% passing

---

## Running Tests

```bash
# Run all tests
npm test

# Run in watch mode (interactive)
npx jest --watch

# Run a specific test suite
npx jest orderFields
npx jest fulfillment
npx jest admin

# Run with verbose output
npx jest --verbose

# Run with coverage
npx jest --coverage

# Run specific test file
npx jest src/tests/order.test.js
```

---

## Test Environment

Tests run against a real (in-memory or test-URI) MongoDB instance. The test environment:

- Uses `NODE_ENV=test` which disables morgan logging
- Skips background cron jobs (`fulfillmentJob.start()` and `syncProvidersJob.start()`)
- Uses the `MONGO_URI` from `.env` (override with `MONGO_URI=mongodb://localhost:27017/test_db` in CI)
- Falls back to `MockProviderAdapter` for all provider adapter calls

---

## Test Suite Index

### 1. `auth.test.js` — Authentication

Tests the full authentication flow.

**Covers:**
- `POST /api/auth/register` — valid registration, duplicate email, validation errors
- `POST /api/auth/login` — valid credentials, wrong password, unverified account, inactive account
- `GET /api/auth/verify-email` — valid token, expired token, already-verified
- `POST /api/auth/resend-verification` — rate limiting, unknown email
- Google OAuth — route guard when credentials not configured (503 response)

**Notable tests:**
```
✓ register with valid data creates user with PENDING status
✓ login fails if email not verified
✓ login fails if user status is PENDING (not approved)
✓ login succeeds after verification and admin approval
✓ duplicate email returns 409 CONFLICT
```

---

### 2. `activation.test.js` — User Approval Lifecycle

Tests admin approval and rejection of users.

**Covers:**
- `PATCH /api/admin/users/:id/approve` — PENDING → ACTIVE
- `PATCH /api/admin/users/:id/reject` — PENDING → REJECTED
- Admin-only guard (non-admin cannot call)
- Audit log creation on approval/rejection
- Login blocked for REJECTED users

---

### 3. `order.test.js` — Order Creation and Lifecycle

Tests the complete order service.

**Covers:**
- Successful order creation with all field snapshots
- `INSUFFICIENT_FUNDS` when wallet too low
- Atomic debit: only one of two concurrent orders succeeds when wallet barely covers one
- Idempotency: duplicate `idempotencyKey` returns 409
- Pricing isolation: group or product price changes do not affect existing orders
- Currency snapshot: `rateSnapshot`, `chargedAmount`, `usdAmount` frozen at creation

**Notable tests:**
```
✓ creates order and debits wallet atomically
✓ concurrent orders — only one succeeds if funds cover one
✓ second request with same idempotencyKey returns 409
✓ order snapshot preserves group at time of creation
✓ changing product price after order does not affect existing order
```

---

### 4. `orderFields.test.js` — Dynamic Field Validation

37 tests covering the full validator.

**Covers:**
- Valid submission with all field types
- Rejection of unknown keys
- Required field enforcement
- Optional fields allowed absent
- Type validation: text, textarea, number, select, email, tel, date
- Snapshot structure and content
- Product model integration: orderFields are stored and retrieved correctly
- Order creation rejects invalid field submissions before wallet debit
- Admin API: create product with orderFields, update orderFields

**Notable tests:**
```
✓ rejects unknown submitted keys
✓ rejects all missing required fields in a single error message
✓ coerces numeric string "500" to number 500
✓ select rejects invalid option with list of valid options
✓ optional absent field is not in values but is in fieldsSnapshot
✓ inactive field is ignored in validation and excluded from snapshot
✓ order creation with invalid fields does NOT debit wallet
```

---

### 5. `orderFieldsExtended.test.js` — Extended Field System Tests

33 tests covering the 4 audit gaps implemented later.

**Section [1] — URL Field Type (8 tests):**
```
✓ accepts https://youtube.com/watch?v=xyz
✓ accepts http://example.com
✓ rejects "ftp://example.com"
✓ rejects "not-a-url"
✓ rejects empty URL for required field
✓ accepts optional absent URL
✓ stores url value in order customerInput.values
✓ url key appears in fieldsSnapshot
```

**Section [2] — Number min/max Enforcement (9 tests):**
```
✓ accepts value at exactly min bound
✓ accepts value at exactly max bound
✓ rejects value below min
✓ rejects value above max
✓ accepts value with only min defined
✓ accepts value with only max defined
✓ min and max preserved in fieldsSnapshot
✓ multiple number violations collected in single error
```

**Section [3] — applyProviderMapping Unit Tests (8 tests):**
```
✓ returns values unchanged when mapping is null
✓ returns values unchanged when mapping is empty
✓ translates keys present in mapping
✓ passes through keys not in mapping
✓ handles Mongoose Map instance
✓ handles plain object mapping
✓ does not mutate original values
✓ works with multiple keys translated simultaneously
```

**Section [4] — providerMapping CRUD (8 tests):**
```
✓ createProduct stores providerMapping correctly
✓ providerMapping retrieved as Map on product read
✓ updateProduct appends/replaces providerMapping keys
✓ executeOrder passes translated values to provider adapter
```

---

### 6. `fulfillment.test.js` — Fulfillment Engine

Tests `orderFulfillment.service.js` and `executeOrder()`.

**Covers:**
- `executeOrder()` with terminal success → order COMPLETED
- `executeOrder()` with terminal failure → order FAILED + wallet refunded
- `executeOrder()` with pending → order PROCESSING, `providerOrderId` set
- Provider mapping applied before `placeOrder` call
- `providerRawResponse` stored on order
- Refund idempotency: `order.refunded = true` before refund, then not refunded twice
- Audit log written for provider order placement

---

### 7. `orderPolling.test.js` — Status Polling and Cron Behavior

691-line test file. Tests the polling system exhaustively.

**Covers:**
- `getOrderStatus` returning terminal success → COMPLETED
- `getOrderStatus` returning terminal failure → FAILED + refund
- `getOrderStatus` returning non-terminal → retryCount++, lastCheckedAt updated
- Batch status check (`checkOrders`)
- Status string normalization (case-insensitive)
- Multi-provider isolation: polling one provider's orders doesn't touch another's
- `retryCount >= MAX_RETRY_COUNT (5)` → force FAILED + refund
- Correct oldest-checked-first ordering (sorted by `lastCheckedAt ASC`)
- `isTerminal()` and `requiresRefund()` utility function coverage

---

### 8. `wallet.test.js` — Wallet Atomicity

Tests all three wallet operations.

**Covers:**
- `debitWalletAtomic` — sufficient funds, insufficient funds, zero amount, no session
- `refundWalletAtomic` — restores balance, `creditUsed` is clamped to 0
- `creditWalletDirect` — increases balance, creates CREDIT transaction
- WalletTransaction records verify `balanceBefore`/`balanceAfter` accuracy
- TOCTOU simulation: concurrent debits with only one succeeding

---

### 9. `deposit.test.js` — Deposit Request Workflow

**Covers:**
- Create deposit request
- List pending deposits
- Admin approve — wallet credited
- Admin reject — wallet unchanged
- Cannot approve already-approved deposit
- Cannot approve already-rejected deposit
- `overrideAmount` used instead of `amountRequested`

---

### 10. `catalog.test.js` — Product Catalog

Tests `product.service.js` and `providerCatalog.service.js`.

**Covers:**
- Create product from ProviderProduct
- `pricingMode: sync` — basePrice updated when provider price changes
- `pricingMode: manual` — basePrice unchanged despite provider price updates
- Order pricing isolation from product price changes

---

### 11. `provider.test.js` — Provider Model and Sync Engine

**Covers:**
- Provider creation and `slug` auto-generation
- Sync engine: `upsert` behavior for ProviderProduct
- `translatedName` preserved across syncs
- `rawPayload` replaced wholesale on each sync
- `isTerminal` and `requiresRefund` utilities
- Adapter factory resolution by slug/name

---

### 12. `adapters.test.js` — Live Adapter Layer

**Covers:**
- `getAdapter()` resolves correct class by slug and name
- Strict mode throws `UNSUPPORTED_PROVIDER` for unknowns
- `registerAdapter()` adds custom adapter at runtime
- `TorosfonAdapter.getBalance()` calls correct endpoint
- `AlkasrVipAdapter.getBalance()` calls correct endpoint
- Mock adapter satisfies all interface methods

---

### 13. `admin.test.js` — Admin APIs

734-line test file covering all admin management endpoints.

**Covers:**
- User listing, approval, rejection, soft-delete
- Wallet add/deduct with transaction record verification
- Settings CRUD
- Group create/update/deactivate
- Admin-only guards (non-admin gets 403)

---

### 14. `audit.test.js` — Audit Log System

**Covers:**
- `createAuditLog()` writes immutable record
- Sensitive key redaction: password, token, apikey → `[REDACTED]`
- Circular reference handling in metadata sanitization
- All `ALL_ACTIONS` constants are recognized
- `getEntityAuditLogs()` and `getActorAuditLogs()` pagination
- Pre-hook prevents update/delete on AuditLog collection

---

### 15. `currency.test.js` — Currency Management

**Covers:**
- Currency model validation (3-letter ISO 4217 code)
- `effectiveRate` and `spreadPercent` virtuals
- Admin `PATCH /admin/currencies/:code` updates `platformRate`
- Exchange rate sync service: fetches external rates and updates `marketRate`

---

### 16. `pricing.test.js` — Pricing Calculation

**Covers:**
- `calculateFinalPrice(basePrice, percentage)` — pure function
  - 0% markup → same price
  - 15% markup → correct result
  - 100% markup
  - Negative basePrice throws
  - Negative percentage throws
- `calculateUserPrice(userId, basePrice)` — with DB
  - Loads correct group percentage
  - Inactive group throws `GROUP_INACTIVE`
  - No group throws `NO_GROUP_ASSIGNED`

---

### 17. `group.test.js` — Pricing Groups

**Covers:**
- Create group with valid percentage
- Duplicate name returns 409
- Update percentage
- Deactivate group
- `listGroups({ includeInactive: true })` returns all
- New user auto-assigned to highest-percentage group

---

## Test Helpers

**File:** `src/tests/testHelpers.js`

Provides shared setup utilities:

| Helper | Purpose |
|--------|---------|
| `createTestUser(overrides)` | Create a user in any state |
| `createAdminUser()` | Create pre-approved ADMIN user |
| `createActiveUser()` | Create pre-approved CUSTOMER user |
| `getAuthToken(user)` | Generate valid JWT for a user |
| `createTestProduct(overrides)` | Create product with optional orderFields |
| `createTestProvider(overrides)` | Create provider document |
| `cleanDatabase()` | Drop all test collections between tests |

---

## Jest Configuration

From `package.json`:

```json
{
  "jest": {
    "testEnvironment": "node",
    "testMatch": ["**/tests/**/*.test.js"],
    "setupFilesAfterFramework": ["./src/tests/setup.js"],
    "testTimeout": 30000
  }
}
```

The 30-second timeout accommodates MongoDB connection setup and async I/O in integration tests.

---

## Writing New Tests

### Standard Test File Structure

```js
'use strict';

const mongoose = require('mongoose');
const { createActiveUser, createTestProduct, getAuthToken, cleanDatabase } = require('./testHelpers');

beforeAll(async () => {
    await mongoose.connect(process.env.MONGO_URI);
});

afterAll(async () => {
    await cleanDatabase();
    await mongoose.disconnect();
});

describe('[1] Feature Name', () => {
    test('does the expected thing', async () => {
        // Arrange
        const user = await createActiveUser();
        const token = getAuthToken(user);
        const product = await createTestProduct({ isActive: true });

        // Act & Assert
        // ...
    });
});
```

### Testing Order Fields Validation (Pure)

```js
const { validateOrderFields } = require('../modules/orders/orderFields.validator');

const fields = [
    { id: 'f1', key: 'player_id', label: 'Player ID', type: 'text',
      required: true, isActive: true }
];

// Should succeed
const { values, fieldsSnapshot } = validateOrderFields(fields, { player_id: 'hero_123' });

// Should throw
expect(() => validateOrderFields(fields, {})).toThrow('INVALID_ORDER_FIELDS');
```

### Testing Provider Mapping (Pure)

```js
const { applyProviderMapping } = require('../modules/orders/orderFields.validator');

const result = applyProviderMapping(
    { player_id: 'hero_123', server: 'EU' },
    { player_id: 'link', server: 'server_id' }
);
// result = { link: 'hero_123', server_id: 'EU' }
```
