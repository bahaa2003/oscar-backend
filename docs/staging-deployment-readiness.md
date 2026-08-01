# Staging Deployment Readiness

This package prepares a controlled Staging rollout only. It does not deploy to Production, create indexes by default, repair records, call providers, or print secrets.

## Environment Checklist

Backend Staging requires values for:

| Variable | Required | Secret | Notes |
| -------- | -------- | ------ | ----- |
| `NODE_ENV=staging` | Yes | No | Use PM2 `--env staging`. |
| `PORT` | Yes | No | Staging API port. |
| `MONGO_URI` | Yes | Yes | Backend runtime database URI. Must point to Staging replica set/Atlas. |
| `STAGING_MONGO_URI` | Operator scripts only | Yes | Used by Phase 4B staging scripts; no fallback to Production. |
| `JWT_SECRET` | Yes | Yes | Staging-only random secret. |
| `JWT_EXPIRES_IN` | Yes | No | Existing default is `7d`. |
| `BCRYPT_ROUNDS` | Yes | No | Existing default is `12`. |
| `APP_URL` | Yes | No | Staging backend public origin for server-generated links. |
| `FRONTEND_URL` | Yes | No | Staging frontend origin. |
| `FRONTEND_VERIFY_REDIRECT_URL` | Yes | No | Staging email verification redirect. |
| `ALLOWED_ORIGINS` | Yes | No | Staging frontend origins only. |
| `GOOGLE_CLIENT_ID` | OAuth if enabled | No | Staging OAuth client. |
| `GOOGLE_CLIENT_SECRET` | OAuth if enabled | Yes | Staging OAuth client secret. |
| `GOOGLE_CALLBACK_URL` | OAuth if enabled | No | Staging backend callback URL. |
| `GOOGLE_OAUTH_STATE_SECRET` | OAuth if enabled | Yes | Long random value. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` | Email if enabled | Mixed | Staging mail provider or sandbox. |
| `REFERRAL_COMMISSION_ENABLED` | Yes | No | Disabled or zero rate creates no commissions. |
| `REFERRAL_COMMISSION_RATE_PERCENT` | When enabled | No | Explicit Decimal-compatible percent from `0` to `100`. |
| `REFERRAL_PAYOUT_MIN_USD` | Yes | No | Non-negative Decimal string. |
| `RESELLER_REAPPLICATION_COOLDOWN_DAYS` | Yes | No | Non-negative number. |
| Provider API URLs/tokens | Provider testing only | Yes for tokens | Use sandbox provider credentials where possible. |
| `EXCHANGE_RATE_API_URL`, `EXCHANGE_RATE_API_KEY`, `EXCHANGE_RATE_TIMEOUT_MS` | Currency sync if enabled | Key may be secret | Do not run external sync during readiness checks. |
| WhatsApp LocalAuth variables | If WhatsApp enabled | No secrets in example | Run only one PM2 worker for one LocalAuth data dir. |

Frontend Staging requires:

| Variable | Required | Secret | Notes |
| -------- | -------- | ------ | ----- |
| `VITE_DATA_PROVIDER=real` | Yes | No | Real API mode for Staging. |
| `VITE_API_BASE_URL` | Yes | No | Staging Backend `/api` URL. |
| `VITE_PUBLIC_APP_URL` | Yes | No | Staging frontend public origin. |
| `VITE_ADMIN_WHATSAPP_NUMBER` | Optional | No | Public support number. |
| `VITE_APP_ENV=staging` | Yes | No | Environment label. |
| `VITE_APP_MODE=staging` | Yes | No | Mode label. |
| `VITE_OSCAR_BUILD_ID` / `VITE_APP_VERSION` | Optional | No | Build traceability. |

## Transaction Topology

Staging MongoDB must support MongoDB multi-document transactions. Use MongoDB Atlas or a replica set. Standalone MongoDB is not acceptable for deposit approval, wallet ledger idempotency, referral commissions, payouts, reseller application transactions, and reseller pricing/order snapshot verification.

Read-only check:

```bash
node scripts/financialTopologyPreflight.js --check
```

## Index Rollout

Dry-run first:

```bash
set STAGING_MONGO_URI=<staging-uri>
node scripts/stagingIndexRollout.js --staging --check
```

Apply only after duplicate blockers are resolved manually:

```bash
set STAGING_MONGO_URI=<staging-uri>
node scripts/stagingIndexRollout.js --staging --apply
```

The script prints the target database name and redacts URI credentials. It refuses production-like database names and never deletes or edits conflicting records.

Required cross-phase indexes include referral identity, wallet source idempotency, referral commission uniqueness, payout idempotency, reseller application uniqueness, OAuth handoff/state indexes, order idempotency, polling, and non-empty order-number uniqueness.

## Read-Only Verification Orchestrator

Run only with an explicitly supplied staging URI:

```bash
set STAGING_MONGO_URI=<staging-uri>
node scripts/stagingReadinessOrchestrator.js --staging --check
```

The orchestrator runs only read-only checks:

- `financialTopologyPreflight.js --check`
- `walletLedgerIdempotencyPreflight.js --check`
- `depositApprovalReconciliationPreflight.js --check`
- `referralPayoutReconciliationPreflight.js --check`
- `resellerApplicationReconciliationPreflight.js --check`
- `resellerPricingReconciliationPreflight.js --check`
- `systemReadinessPreflight.js --check`
- `stagingIndexRollout.js --staging --check`

## PM2 Staging

Suggested controlled start:

```bash
npm ci
pm2 start ecosystem.config.js --env staging
pm2 logs digital-platform-api
```

The ecosystem file uses one forked instance. Keep it that way when WhatsApp LocalAuth is enabled, or explicitly disable WhatsApp with `WHATSAPP_ENABLED=false`.

## Frontend Staging Build

Set staging frontend env values, then run:

```bash
npm ci
npm run build
```

Deploy the generated `dist/` artifact to the approved Staging host only.

## Smoke-Test Checklist

- Auth: register, verify email, login, blocked inactive/rejected login.
- Referral registration: signup with referral code and verify immutable attribution.
- Google OAuth referral: initiate with referral, complete callback handoff, verify attribution only for new user.
- Deposit approval: approve pending deposit, verify wallet credit and one wallet ledger.
- Referral commission: eligible deposit creates one AVAILABLE commission in the same approval transaction.
- Referral dashboard: current user sees only own code, invitees, Decimal totals, history, filters, and pagination.
- Payouts: create payout, reject payout, settle WALLET payout, settle MANUAL payout; verify no duplicate wallet credit.
- Reseller workflow: submit, approve, reject, suspend to previous/highest eligible normal Group, reactivate with reseller Group.
- Reseller pricing: quote approved reseller price, quote suspended/default price, create order and verify immutable snapshots.
- Provider fulfillment: use sandbox/mocked provider credentials, place automatic order, poll processing order, verify canonical statuses and refunds.

## Rollback Plan

- Do not reprice historical orders.
- Do not delete duplicate data automatically.
- If index apply is blocked, stop rollout and reconcile data manually in a separately approved maintenance plan.
- If app smoke tests fail, stop PM2 staging process or revert deployment artifact using the hosting provider rollback.
- If WhatsApp LocalAuth conflicts occur, disable WhatsApp or stop extra processes before retrying.
