# Digital Products Platform

A production-grade **Node.js + Express + MongoDB** backend platform for selling digital products (top-ups, subscriptions, game credits, etc.) through multiple external providers. The system supports multi-currency wallets, group-based pricing, dynamic per-product order forms, and a fully automated fulfillment engine.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Key Features](#2-key-features)
3. [System Architecture](#3-system-architecture)
4. [Core Modules](#4-core-modules)
5. [Dynamic Order Fields System](#5-dynamic-order-fields-system)
6. [Provider Mapping](#6-provider-mapping)
7. [Order Lifecycle](#7-order-lifecycle)
8. [Wallet & Credit System](#8-wallet--credit-system)
9. [Authentication & Security](#9-authentication--security)
10. [Admin Capabilities](#10-admin-capabilities)
11. [Test Coverage](#11-test-coverage)
12. [Setup & Installation](#12-setup--installation)

---

## 1. Project Overview

The **Digital Products Platform** is a B2B/B2C reseller backend. It connects to multiple external "provider" APIs (Royal Crown, Torosfon, Alkasr VIP, etc.), syncs their product catalogues, and lets admins publish curated products to customers at marked-up prices.

**Core problems solved:**

- Maintaining a clean internal product catalogue that is decoupled from volatile provider APIs
- Collecting per-product custom data from customers at order time (e.g. "Player ID", "Server region", "Username") via a dynamic forms engine
- Forwarding translated field values to provider APIs using a configurable key-mapping system
- Ensuring atomic financial safety: wallets are debited and refunded without race conditions
- Providing full traceability through immutable audit logs and order snapshots

---

## 2. Key Features

### Dynamic Order Fields
Admins define custom input fields per product (text, number, URL, select, email, tel, date). The backend validates submitted values, applies type-coercion, enforces min/max bounds on numbers, validates URL format, and stores an **immutable snapshot** alongside each order.

### Provider Mapping (`providerMapping`)
Each product carries a `providerMapping` (Mongoose `Map`) that translates internal field keys to the exact parameter names the provider API expects. The fulfillment engine applies this translation before calling `provider.placeOrder()`.

### Multi-Currency Wallet System
Users hold wallets in their own currency (USD, SAR, EGP, etc.). Product prices are in USD. A two-layer currency system (`marketRate` → `platformRate`) controlled by admins converts at order time. Every debit/credit is an atomic MongoDB operation — no race conditions.

### Credit System
Users can be assigned a **credit limit** by admins. Wallet pays first; any remaining amount draws from the credit line. On refund, credit is repaid before wallet balance is restored. `availableBalance = walletBalance + (creditLimit − creditUsed)`.

### Group-Based Pricing
Every user belongs to a **pricing group** with a markup percentage. Final order price = `basePrice × (1 + markup/100)`, rounded to 2 decimal places. Price is snapshot-frozen on the order at creation time.

### Role-Based Access Control (RBAC)
Three user roles: `ADMIN`, `SUPERVISOR`, `CUSTOMER`. Admins have full access. Supervisors receive **granular permissions** (e.g. `MANAGE_DEPOSITS`, `VIEW_USERS`, `CONFIRM_ORDERS`) — a `requirePermission()` middleware enforces per-route access.

### Two-Factor Authentication (Email OTP)
Users can enable 2FA on their account. On login, an email OTP is sent instead of granting immediate access. The client receives a temporary token (`purpose: 2fa-pending`) and must exchange it + OTP code for a full JWT.

### Order Processing
Seven order statuses: `PENDING → PROCESSING → COMPLETED | FAILED | CANCELED | PARTIAL | MANUAL_REVIEW`. Automatic products are dispatched to the provider immediately after wallet debit, with asynchronous status polling via a cron job (every minute). Orders exceeding 24 retry attempts are moved to `MANUAL_REVIEW` (kill-switch).

### Target Coin Purchases
A secondary order system where customers submit coin purchase requests (with payment proof screenshots) for admin-managed "target apps". Admins review, approve, or reject each request.

### Notification System
In-app notification inbox supporting both targeted (per-user) and broadcast messages. Admins can send notifications to individual users, groups, or all users. Customers see unread badge counts and can mark notifications as read.

### Admin Product Management
Admins can: create standalone products manually, publish products from an external provider catalogue, set orderFields, set providerMapping, manage pricing mode (sync vs manual), and toggle visibility.

### Fulfillment Engine
A dedicated service (`orderFulfillment.service.js`) handles the full provider lifecycle: place order, receive response, map status, handle failures, and issue atomic refunds. The cron job (`fulfillmentJob`) polls PROCESSING orders every minute and drives them to a terminal state.

### Provider Integration
Three live adapters (Royal Crown, Torosfon, Alkasr VIP) plus a Mock adapter for testing. Each adapter implements: `getProducts()`, `placeOrder()`, `getOrderStatus()`, `checkOrders()` (batch), and `getBalance()`. The factory resolves adapters by slug or name.

### Immutable Audit Logs
Every significant action (registration, login, order, wallet debit/credit, deposit approval, target order review, provider calls) writes an immutable AuditLog document. Sensitive fields (passwords, tokens) are automatically redacted.

### Deposit Workflow
Customers submit deposit requests with a transfer screenshot. An optional **receipt analyzer** (sharp + Tesseract OCR) validates image authenticity (entropy, solid-color detection, keyword matching). Admins review and approve/reject. Approved deposits atomically credit the user's wallet.

### Email Service
Nodemailer-backed email service supporting multiple SMTP providers (Gmail, Mailtrap, custom). Sends verification emails and 2FA OTP codes with branded HTML templates. Silently no-ops in test environment.

### Test Coverage
**20 test suites** — all passing. Covers models, services, validators, fulfillment logic, wallet atomicity, order lifecycle, providers, admin APIs, dynamic field system, receipt analyzer, target apps, and sync upgrades.

---

## 3. System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Express App                          │
│                         (app.js)                            │
├──────────────┬──────────────┬──────────────┬────────────────┤
│ Public Auth  │ User Panel   │ Admin Panel  │ Shared Routes  │
│ /api/auth/*  │ /api/me/*    │ /api/admin/* │ /api/products  │
│              │ /api/me/     │ /api/admin/  │ /api/orders    │
│              │  targets/*   │  catalog/*   │ /api/wallet    │
│              │  notifs/*    │  target-apps │ /api/deposits  │
│              │              │  notifs/*    │ /api/categories│
└──────┬───────┴──────┬───────┴──────┬───────┴────────┬───────┘
       │              │              │                │
  ┌────▄────┐   ┌─────▄────┐  ┌─────▄─────┐  ┌──────▄──────┐
  │  Auth   │   │   User   │  │   Admin   │  │   Orders    │
  │ Service │   │  Panel   │  │ Services  │  │  Service    │
  └────┬────┘   └─────┬────┘  └─────┬─────┘  └──────┬──────┘
       │              │              │                │
  ┌────▄──────────────────▄──────────────────▄──────┐
  │                   MongoDB (Mongoose ODM)                  │
  │  User  Order  Product  ProviderProduct  WalletTransaction │
  │  Provider  DepositRequest  Currency  Group  AuditLog      │
  │  Notification  TargetApp  TargetOrder  Category  Setting  │
  └─────────────────────────────┬─────────────────────────────┘
                                │
              ┌─────────────────▄─────────────────┐
              │     Background Cron Jobs           │
              │  fulfillmentJob (every 1 min)      │
              │  syncProvidersJob (every 6 hours)  │
              └─────────────────┬─────────────────┘
                                │
              ┌─────────────────▼─────────────────┐
              │      Provider Adapter Layer        │
              │  Royal Crown | Torosfon | Alkasr   │
              │  VIP | Mock (fallback)             │
              └───────────────────────────────────┘
```

### Three-Layer Product Architecture

```
Layer 1: Provider          (external API data source)
Layer 2: ProviderProduct   (raw synced catalogue, internal only)
Layer 3: Product           (admin-curated, customer-facing)
```

Admins cherry-pick from Layer 2 to publish Layer 3 products. Pricing can be linked to raw price (sync mode) or set independently (manual mode).

---

## 4. Core Modules

| Module | Path | Responsibility |
|--------|------|---------------|
| `auth` | `src/modules/auth` | Registration, login, email verification, Google OAuth, 2FA (Email OTP) |
| `users` | `src/modules/users` | User model, CRUD, role & permission management |
| `products` | `src/modules/products` | Platform product catalogue |
| `orders` | `src/modules/orders` | Order creation, validation, lifecycle, fulfillment engine |
| `wallet` | `src/modules/wallet` | Atomic wallet operations, credit system |
| `deposits` | `src/modules/deposits` | Deposit request flow, receipt analysis |
| `providers` | `src/modules/providers` | Provider model + adapter system |
| `currency` | `src/modules/currency` | Exchange rate management |
| `groups` | `src/modules/groups` | Pricing tier (markup) groups |
| `categories` | `src/modules/categories` | Product categories (admin + public) |
| `targets` | `src/modules/targets` | Target coin purchase apps & orders |
| `notifications` | `src/modules/notifications` | In-app notification system |
| `audit` | `src/modules/audit` | Immutable event audit logs |
| `me` | `src/modules/me` | User self-service panel API |
| `admin` | `src/modules/admin` | Admin dashboard APIs |
| `shared` | `src/shared` | Errors, middleware, utilities |

---

## 5. Dynamic Order Fields System

### Why They Exist

Digital products like game top-ups require provider-specific customer data (e.g. player ID, server, username). This data varies per product and per provider. Rather than hardcoding fields, the platform lets admins define a custom form schema on each product.

### Field Types

| Type | Validation |
|------|-----------|
| `text` | Non-empty string |
| `textarea` | Non-empty string |
| `number` | Numeric; optional `min`/`max` bounds enforced |
| `url` | Must match `https?://...` pattern |
| `select` | Value must be in `options` array |
| `email` | Non-empty string (format hint; no regex enforced) |
| `tel` | Non-empty string |
| `date` | Non-empty string |

### Admin Configuration

Product `orderFields` is an array of field definitions:

```json
{
  "orderFields": [
    {
      "id":        "f1",
      "key":       "player_id",
      "label":     "Player ID",
      "type":      "text",
      "required":  true,
      "isActive":  true
    },
    {
      "id":        "f2",
      "key":       "server",
      "label":     "Server Region",
      "type":      "select",
      "options":   ["NA", "EU", "AS"],
      "required":  true,
      "isActive":  true
    },
    {
      "id":        "f3",
      "key":       "amount",
      "label":     "Diamond Amount",
      "type":      "number",
      "min":       100,
      "max":       10000,
      "required":  true,
      "isActive":  true
    }
  ]
}
```

### Validation Rules

1. **Unknown keys** — any submitted key not in active `orderFields` is immediately rejected
2. **Required fields** — missing or empty required fields are rejected
3. **Type validation** — every field is type-checked and coerced (numbers) or validated (URLs, selects)
4. **Min/Max** — `number` fields enforce bounds when defined
5. **Inactive fields** — completely ignored (not validated, not stored in snapshot)
6. **Multiple errors** — all violations collected before throwing a single `BusinessRuleError`

### Immutable Order Snapshot

When an order is created, the validator returns:

```js
{
  values: { player_id: "hero_123", server: "EU", amount: 500 },
  fieldsSnapshot: [
    { key: "player_id", label: "Player ID", type: "text" },
    { key: "server",    label: "Server Region", type: "select", options: ["NA","EU","AS"] },
    { key: "amount",    label: "Diamond Amount", type: "number", min: 100, max: 10000 }
  ]
}
```

Both are stored on `Order.customerInput` and **never mutated** — admin changes to `orderFields` do not rewrite historical orders.

---

## 6. Provider Mapping

### Why Mapping Is Needed

Internal field keys use human-readable names (`player_id`, `server`). Provider APIs may expect entirely different parameter names (`link`, `server_id`). Rather than hardcoding these translations in adapter code, each product carries a `providerMapping` Map.

### Configuration

```json
{
  "providerMapping": {
    "player_id": "link",
    "server": "server_id"
  }
}
```

### How It Works

At fulfillment time, `applyProviderMapping(values, providerMapping)` translates the stored `customerInput.values`:

```
Internal:  { player_id: "hero_123", server: "EU" }
            ↓ applyProviderMapping
Provider:  { link: "hero_123", server_id: "EU" }
```

Keys **not** present in the mapping are passed through unchanged. The resulting object is spread into the provider's `placeOrder()` call alongside `externalProductId` and `quantity`.

### Example placeOrder Call

```js
provider.placeOrder({
  externalProductId: "RES-001",
  quantity: 1,
  link: "hero_123",       // ← player_id translated
  server_id: "EU",        // ← server translated
})
```

---

## 7. Order Lifecycle

```
Customer submits POST /api/me/orders
    { productId, quantity, orderFieldsValues }
         │
         ▼
  ┌─────────────────────────────────┐
  │ 1. Product lookup + validation  │
  │    - product must be active     │
  │    - quantity within bounds     │
  └────────────────┬────────────────┘
                   │
                   ▼
  ┌─────────────────────────────────┐
  │ 2. Dynamic field validation     │
  │    validateOrderFields()        │
  │    - unknown keys rejected      │
  │    - required fields checked    │
  │    - types validated/coerced    │
  │    - min/max enforced           │
  └────────────────┬────────────────┘
                   │
                   ▼
  ┌─────────────────────────────────┐
  │ 3. Pricing calculation          │
  │    calculateUserPrice()         │
  │    - basePrice + group markup   │
  │    - currency rate applied      │
  └────────────────┬────────────────┘
                   │
                   ▼
  ┌─────────────────────────────────┐
  │ 4. MongoDB transaction start    │
  └────────────────┬────────────────┘
                   │
                   ▼
  ┌─────────────────────────────────┐
  │ 5. Idempotency check            │
  │    (userId + idempotencyKey)    │
  └────────────────┬────────────────┘
                   │
                   ▼
  ┌─────────────────────────────────┐
  │ 6. Atomic wallet debit          │
  │    debitWalletAtomic()          │
  │    walletBalance >= totalPrice  │
  └────────────────┬────────────────┘
                   │
                   ▼
  ┌─────────────────────────────────┐
  │ 7. Order document created       │
  │    with all price snapshots,    │
  │    customerInput, fieldsSnapshot│
  └────────────────┬────────────────┘
                   │
                   ▼
  ┌─────────────────────────────────┐
  │ 8. Transaction committed        │
  └────────────────┬────────────────┘
                   │
          ┌────────┴────────┐
          │                 │
    executionType        executionType
    = MANUAL            = AUTOMATIC
          │                 │
    status=PENDING   ┌──────▼──────────────────────┐
                     │ 9. executeOrder() (async)    │
                     │    applyProviderMapping()     │
                     │    provider.placeOrder()      │
                     └──────┬──────────────────────┘
                            │
                     ┌──────▼──────────────────────┐
                     │ 10. Provider response        │
                     │   success + Completed        │
                     │     → COMPLETED              │
                     │   success + Pending          │
                     │     → PROCESSING (polling)   │
                     │   success + Cancelled        │
                     │     → FAILED + refund        │
                     │   failure                    │
                     │     → FAILED + refund        │
                     └─────────────────────────────┘
                            │
                      PROCESSING orders polled
                      every 1 minute by cron:
                      provider.getOrderStatus()
                      or provider.checkOrders()
                      until terminal state or
                      MAX_RETRY_COUNT (24) exceeded
                      → MANUAL_REVIEW (kill-switch)
```

---

## 8. Wallet & Credit System

### Balance Rules

- **Wallet-first policy** — orders debit wallet first; if insufficient, remaining draws from credit line
- **Credit limit** — admin-assigned per-user; `availableBalance = walletBalance + (creditLimit - creditUsed)`
- **No uncontrolled overdraft** — balance can only go negative up to the credit limit
- All operations use **MongoDB aggregation-pipeline `findOneAndUpdate`** — the check and update are a single atomic operation, eliminating TOCTOU race conditions

### Transaction Types

| Type | When |
|------|------|
| `DEBIT` | Order placed |
| `REFUND` | Order failed / admin manual refund |
| `CREDIT` | Deposit approved / admin add funds |
| `ADMIN_DEDUCT` | Admin manual deduction |
| `ADMIN_SET` | Admin set balance override |

### WalletTransaction Record

Every operation writes an immutable `WalletTransaction` document capturing:
- `balanceBefore`, `balanceAfter`
- `amount`, `type`, `description`
- `reference` (Order ID or Deposit ID)
- `createdAt` (immutable timestamp)

### Deposit Flow

```
Customer POST /api/me/deposits
   { amountRequested, transferredFromNumber, screenshotProof }
              │
              ▼ DepositRequest (status=PENDING)
              │
   Admin: PATCH /api/admin/deposits/:id/approve
              │
              ▼ atomic session:
                - creditWalletDirect()
                - DepositRequest status → APPROVED
                - AuditLog written
```

---

## 9. Authentication & Security

### Authentication Flow

```
Registration (POST /api/auth/register)
    → Email verification link sent
    → User clicks link → verified: true
    → Admin approves → status: ACTIVE
    → User can now log in

Google OAuth (GET /api/auth/google)
    → Auto-verified (no email link needed)
    → Still requires admin approval (status: PENDING → ACTIVE)
```

### Two-Factor Authentication (Email OTP)

```
Login with 2FA enabled:
    POST /api/auth/login
        → returns { requires2FA: true, tempToken: "..." }
    
    Server sends 6-digit OTP to user's email (5-min expiry)
    
    POST /api/auth/verify-2fa { tempToken, code }
        → returns full JWT on success

Enabling 2FA:
    POST /api/auth/2fa/generate    → sends OTP email
    POST /api/auth/2fa/enable      → confirms with code
    
Disabling 2FA:
    POST /api/auth/2fa/disable     → requires password
```

### Rate Limiting

| Scope | Limit |
|-------|-------|
| Global (`/api/*`) | Configurable via `express-rate-limit` |
| Auth routes (`/api/auth/*`) | Stricter limits |
| Wallet operations | Dedicated `walletLimiter` |

### Middleware Stack

| Middleware | Purpose |
|-----------|---------|
| `authenticate` | JWT verification, attaches `req.user` |
| `authorize(roles...)` | Role-based gate (`ADMIN`, `SUPERVISOR`, `CUSTOMER`) |
| `requirePermission(name)` | Granular permission check (admin bypass) |
| `requireActiveUser` | Blocks `PENDING`/`REJECTED` users |
| `validate` | express-validator error aggregation |

### Security Headers

- **Helmet** — sets security HTTP headers
- **CORS** — `ALLOWED_ORIGINS` enforced in production
- **Password hashing** — bcrypt with configurable rounds
- **JWT** — configurable expiry, `purpose` field for temp tokens
- **Sensitive field exclusion** — `password`, `twoFactorOtp` excluded from queries via `select: false`

---

## 10. Admin Capabilities

### User Management
- List users with filtering by status, role, email, date range, and sort
- Approve / reject users (controls login access)
- Soft-delete and restore users (preserves historical data)
- Update user profile, currency, role, avatar
- Set credit limits
- Assign granular permissions (for Supervisors)
- Reset user passwords
- Bulk debt adjustment (for currency devaluation)

### Product Management
- **Create standalone product** — `POST /admin/products` with orderFields + providerMapping
- **Publish from provider catalogue** — `POST /admin/products/from-provider`
- **Update product** — orderFields, providerMapping, pricing, visibility
- **Toggle active** — hide/show without deleting

### Category Management
- Create/update/toggle/delete product categories
- Categories visible publicly for storefront navigation

### Catalog Sync
- `POST /admin/catalog/sync` — sync all active providers
- `POST /admin/catalog/sync/:providerId` — sync one provider
- View raw provider products before publishing

### Order Management
- List all orders with filtering (status, user, provider, date range, search)
- Manually complete, fail, or update order status
- Retry failed automatic orders
- Manually refund orders
- Sync order status with provider

### Wallet Management
- View all user wallets
- Add / deduct / set balance on any user wallet
- View transaction history per user
- All wallet operations are rate-limited and audited

### Deposit Management
- View all deposit requests with search
- Approve (optionally override amount and currency)
- Reject with admin notes
- Unified review endpoint (approve/reject in one call)

### Target Management
- Create/update/deactivate target apps
- Review target coin purchase orders (approve/reject)

### Notification Management
- View all platform notifications
- Send notifications to: individual users, user groups, or all users (broadcast)

### Currency Management
- Set `platformRate` per currency
- Set `markupPercentage` on top of market rate
- Create new currencies
- Toggle currency active status
- Apply debt adjustment on rate change

### Group (Pricing Tier) Management
- Create/update/deactivate pricing groups
- Each group has a `percentage` markup
- Apply debt adjustment on group percentage change

### Settings
- Key-value store for platform-wide runtime configuration
- Includes payment method settings (public-facing)

### Dashboard Statistics
- Aggregated stats: orders, financials, users, products
- Date range filtering
- Revenue in both local currencies and USD

### Audit Logs
- Query by entity (order, user, wallet, group, target_order, system)
- Query by actor (which admin performed what)

---

## 11. Test Coverage

**20 test suites — all passing**

| Test File | What It Covers |
|-----------|---------------|
| `auth.test.js` | Registration, login, email verification, Google OAuth guards |
| `activation.test.js` | User approval/rejection lifecycle |
| `order.test.js` | Order creation, wallet debit, insufficient funds, idempotency, concurrency |
| `orderFields.test.js` | Dynamic field validator, Product schema with orderFields, snapshot immutability |
| `orderFieldsExtended.test.js` | url type, number min/max, applyProviderMapping, providerMapping CRUD |
| `fulfillment.test.js` | executeOrder scenarios, provider response handling, refund idempotency, cron polling |
| `orderPolling.test.js` | Status polling, batch checks, multi-provider isolation, retry limits, MANUAL_REVIEW kill-switch |
| `wallet.test.js` | Debit atomicity, refund, credit, insufficient funds, credit limit edge cases |
| `deposit.test.js` | Deposit request lifecycle, concurrent approval guard |
| `catalog.test.js` | Product publish flow, price sync mode, ProviderProduct chain |
| `provider.test.js` | Provider model, sync engine, adapter layer, price sync logic |
| `adapters.test.js` | Royal Crown, Torosfon, Alkasr adapters, factory resolution |
| `admin.test.js` | Admin user/wallet/settings/groups APIs |
| `audit.test.js` | Audit log immutability, sensitive-data redaction, all action constants |
| `currency.test.js` | Currency model, rate update, exchange rate sync |
| `pricing.test.js` | calculateFinalPrice pure function, calculateUserPrice |
| `group.test.js` | Group creation, markup logic |
| `receiptAnalyzer.test.js` | Deposit receipt image validation (entropy, solid-color detection) |
| `targetApps.test.js` | Target app CRUD, target order lifecycle |
| `syncUpgrades.test.js` | Provider product sync upgrades, delta handling |

---

## 12. Setup & Installation

### Prerequisites
- Node.js >= 18
- MongoDB (replica set recommended for transaction support)

### 1. Clone & install

```bash
git clone <repo-url>
cd Backend
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
NODE_ENV=development
PORT=3000
MONGO_URI=mongodb://localhost:27017/digital_products_platform

JWT_SECRET=your_super_secret_key
JWT_EXPIRES_IN=7d
BCRYPT_ROUNDS=12

# ── Provider credentials ──────────────────────────────────
ROYAL_CROWN_API_URL=https://royal-croown.com
ROYAL_CROWN_API_TOKEN=your_token

TOROSFON_API_URL=https://torosfon.com
TOROSFON_API_TOKEN=your_token

ALKASR_API_URL=https://alkasr-vip.com
ALKASR_API_TOKEN=your_token

# ── Google OAuth (optional) ───────────────────────────────
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_CALLBACK_URL=http://localhost:3000/api/auth/google/callback

# ── Email / SMTP ──────────────────────────────────────────
SMTP_HOST=sandbox.smtp.mailtrap.io
SMTP_PORT=2525
SMTP_USER=your_smtp_user
SMTP_PASS=your_smtp_pass
EMAIL_FROM=noreply@platform.com
APP_URL=http://localhost:5000

# ── Exchange rates ────────────────────────────────────────
EXCHANGE_RATE_API_URL=https://api.exchangerate.host/latest?base=USD
EXCHANGE_RATE_API_KEY=
EXCHANGE_RATE_TIMEOUT_MS=10000

# ── CORS (production only) ───────────────────────────────
ALLOWED_ORIGINS=https://yourdomain.com

# ── Receipt Analyzer (Deposit Anti-Fraud, optional) ──────
RECEIPT_ANALYZER_ENABLE_OCR=false
RECEIPT_ANALYZER_MIN_ENTROPY=1.0
RECEIPT_ANALYZER_OCR_TIMEOUT_MS=3500
RECEIPT_ANALYZER_OCR_KEYWORDS=تم,نجاح,فودافون,Vodafone,Cash
```

### 3. Run in development

```bash
npm run dev
```

Server starts at `http://localhost:3000`

### 4. Run tests

```bash
npm test              # all suites
npx jest --watch      # interactive watch mode
npx jest orderFields  # specific suite
```

### 5. Health check

```
GET /health
→ { success: true, status: "healthy", environment: "development" }
```

---

## Background Jobs

Two cron jobs start automatically with the server:

| Job | Schedule | Purpose |
|-----|----------|---------|
| `fulfillmentJob` | Every 1 minute | Polls PROCESSING orders → drives to COMPLETED, FAILED, CANCELED, PARTIAL, or MANUAL_REVIEW |
| `syncProvidersJob` | Every 6 hours | Syncs product catalogues from all active providers |

Both stop gracefully on `SIGTERM` / `SIGINT`.

---

## Deployment (PM2)

The project includes an `ecosystem.config.js` for PM2 cluster-mode deployment:

```bash
# Start in production
pm2 start ecosystem.config.js --env production

# View logs
pm2 logs

# Restart / Stop
pm2 restart all
pm2 stop all
```

Configuration: cluster mode (`instances: 'max'`), 512MB memory limit, graceful shutdown with 5s kill timeout.

---

## Error Response Format

All errors follow:

```json
{
  "success": false,
  "message": "Human-readable message",
  "code": "MACHINE_READABLE_CODE",
  "statusCode": 422
}
```

| Code | HTTP | Meaning |
|------|------|---------|
| `VALIDATION_ERROR` | 400 | Request body failed validation |
| `AUTHENTICATION_ERROR` | 401 | Missing or invalid JWT |
| `AUTHORIZATION_ERROR` | 403 | Insufficient role or permission |
| `NOT_FOUND` | 404 | Resource not found |
| `CONFLICT` | 409 | Duplicate resource |
| `INSUFFICIENT_FUNDS` | 422 | Wallet balance + credit too low |
| `INVALID_ORDER_FIELDS` | 422 | Dynamic field validation failed |
| `BUSINESS_RULE_VIOLATION` | 422 | General business rule |
| `ACCOUNT_INACTIVE` | 422 | User not yet approved |

