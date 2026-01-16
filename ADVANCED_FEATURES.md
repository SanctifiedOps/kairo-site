# KAIRO Advanced Features Documentation

This document describes the advanced features implemented in KAIRO: TypeScript support, Progressive Rate Limiting, Anomaly Detection, and Comprehensive Testing.

---

## Table of Contents

1. [TypeScript Migration](#typescript-migration)
2. [Progressive Rate Limiting](#progressive-rate-limiting)
3. [Anomaly Detection System](#anomaly-detection-system)
4. [Testing Framework](#testing-framework)
5. [Configuration](#configuration)
6. [Monitoring & Alerts](#monitoring--alerts)
7. [Troubleshooting](#troubleshooting)

---

## TypeScript Migration

### Overview

The project now has full TypeScript support with separate configurations for client and server code.

### Configuration Files

- **tsconfig.json** - Base TypeScript configuration
- **tsconfig.server.json** - Server-side configuration
- **tsconfig.app.json** - Client-side (React/Vite) configuration

### Build Commands

```bash
# Type check without emitting
npm run type-check

# Build server code
npm run build:server

# Build client code
npm run build:client

# Build both
npm run build
```

### Development

```bash
# Run server with TypeScript support
npm run start:ts

# Watch mode for development
npm run dev
```

### Migration Status

**Completed:**
- ✅ TypeScript configuration setup
- ✅ Type definitions installed
- ✅ Build scripts configured
- ✅ Test framework configured

**Pending:**
- ⏳ Full server.js → server.ts migration
- ⏳ Full frontend migration to .tsx
- ⏳ Type annotations for all functions

**Note:** TypeScript is fully configured and ready. Code can be migrated incrementally without breaking existing functionality.

---

## Progressive Rate Limiting

### Overview

Progressive rate limiting adjusts request limits based on wallet reputation, providing better service to established users while protecting against abuse from new accounts.

### Rate Limit Tiers

| Tier | Reputation Score | Max Requests | Window | Description |
|------|-----------------|--------------|--------|-------------|
| **New** | 0-19 | 3 requests | 1 minute | New wallets with no history |
| **Regular** | 20-49 | 8 requests | 1 minute | Wallets with some activity |
| **Established** | 50-79 | 12 requests | 1 minute | Trusted regular voters |
| **Trusted** | 80-100 | 20 requests | 1 minute | Highly reputable wallets |

### Reputation Calculation

Reputation score is calculated as:

```javascript
reputationScore = min(100, daysSinceFirstSeen * 2 + totalVotes * 0.5)
```

**Factors:**
- **Days since first seen**: +2 points per day
- **Total votes cast**: +0.5 points per vote
- **Maximum score**: 100

### How It Works

1. **First Vote:**
   - Wallet is assigned to "New" tier (3 requests/min)
   - Reputation score starts at 0

2. **Subsequent Votes:**
   - Reputation increases with each vote
   - Rate limit adjusts automatically based on score
   - Tier upgrades are immediate

3. **Rate Limit Enforcement:**
   - Requests are tracked per wallet address
   - Exceeding limits returns HTTP 429
   - Error includes tier info and limits

### API Response

When rate limited:

```json
{
  "error": "RATE_LIMIT",
  "tier": "new",
  "limit": 3,
  "windowMs": 60000
}
```

### Database Storage

**Firestore Collection:** `walletReputation`

**Document Structure:**
```json
{
  "wallet": "wallet_address",
  "firstSeen": "2026-01-16T12:00:00Z",
  "lastSeen": "2026-01-16T14:30:00Z",
  "totalVotes": 45,
  "consecutiveDays": 5,
  "reputationScore": 32.5,
  "flagged": false,
  "flags": []
}
```

### Monitoring

Monitor these metrics:
- Average reputation score across all wallets
- Distribution of tiers
- Rate limit violations by tier
- Time to tier upgrades

---

## Anomaly Detection System

### Overview

The anomaly detection system identifies suspicious voting patterns including coordinated attacks, rapid voting, and bot behavior.

### Detection Algorithms

#### 1. Coordinated Voting Detection

**Criteria:**
- 5 or more wallets vote for the same stance
- Within a 10-second window

**Action:**
- Flags all participating wallets
- Logs warning with wallet addresses
- Continues to track for escalation

**Example Log:**
```
[WARN] Coordinated voting detected {
  cycleId: "c_...",
  stance: "ALIGN",
  count: 7,
  spreadMs: 8432,
  wallets: ["wallet1", "wallet2", ...]
}
```

#### 2. Rapid Voting Detection

**Criteria:**
- Single wallet votes more than 3 times
- Within a 5-minute window

**Action:**
- Flags wallet with "rapid_voting"
- Reduces future rate limits
- May temporarily block wallet

**Example Log:**
```
[WARN] Rapid voting detected {
  wallet: "wallet_address",
  voteCount: 5,
  windowMs: 300000
}
```

#### 3. Bot Behavior Detection

**Criteria:**
- Vote occurs less than 5 seconds after cycle starts
- Indicates automated voting

**Action:**
- Flags wallet with "immediate_voting"
- Marks as potential bot
- Increases monitoring

**Example Log:**
```
[WARN] Bot behavior detected {
  wallet: "wallet_address",
  timeSinceCycleStart: 2341
}
```

### Wallet Flagging

When anomalies are detected, wallets are flagged:

**Flag Structure:**
```json
{
  "reason": "coordinated_voting",
  "at": "2026-01-16T12:00:00Z"
}
```

**Consequences of Flagging:**
- Wallet cannot vote (returns 403 error)
- Reputation score frozen
- Requires manual review for unflagging

**API Response for Flagged Wallet:**
```json
{
  "error": "WALLET_FLAGGED",
  "reason": "anomaly_detected",
  "flags": [
    {"reason": "coordinated_voting", "at": "..."},
    {"reason": "rapid_voting", "at": "..."}
  ]
}
```

### Database Storage

**Firestore Collection:** `votePatterns`

**Document Structure:**
```json
{
  "wallet": "wallet_address",
  "cycleId": "c_...",
  "stance": "ALIGN",
  "timestamp": "2026-01-16T12:00:00Z",
  "timestampMs": 1705406400000
}
```

### Monitoring & Alerts

Set up alerts for:

1. **High Priority:**
   - Coordinated voting detected
   - More than 5 wallets flagged in one cycle
   - Repeated offender (3+ flags)

2. **Medium Priority:**
   - Rapid voting detected
   - Bot behavior detected
   - Unusual voting patterns

3. **Low Priority:**
   - First-time wallet flags
   - Pattern anomalies

### Tuning Detection Parameters

Adjust these constants in `server.js`:

```javascript
// Coordinated voting
const COORDINATED_THRESHOLD = 5;  // Min wallets
const COORDINATED_WINDOW_MS = 10000;  // Time window

// Rapid voting
const RAPID_VOTE_THRESHOLD = 3;  // Max votes
const RAPID_VOTE_WINDOW_MS = 300000;  // 5 minutes

// Bot behavior
const BOT_IMMEDIATE_THRESHOLD_MS = 5000;  // 5 seconds
```

### False Positives

**Common causes:**
- Legitimate coordinated campaigns
- Multiple users from same organization
- Fast internet connections

**Mitigation:**
- Manual review process
- Whitelist for known good actors
- Grace period for first offense

### Analytics Queries

**Firestore queries for analysis:**

```javascript
// Get all flagged wallets
db.collection("walletReputation")
  .where("flagged", "==", true)
  .get();

// Get voting patterns for cycle
db.collection("votePatterns")
  .where("cycleId", "==", cycleId)
  .orderBy("timestampMs", "asc")
  .get();

// Count flags by reason
db.collection("walletReputation")
  .where("flagged", "==", true)
  .get()
  .then(snap => {
    const reasons = {};
    snap.forEach(doc => {
      doc.data().flags.forEach(flag => {
        reasons[flag.reason] = (reasons[flag.reason] || 0) + 1;
      });
    });
    return reasons;
  });
```

---

## Testing Framework

### Overview

Comprehensive testing suite using Vitest (unit/integration) and Playwright (E2E).

### Test Structure

```
kairo-site/
├── __tests__/
│   ├── unit/
│   │   ├── reputation.test.js
│   │   └── anomalyDetection.test.js
│   └── integration/
│       └── api.test.js
├── e2e/
│   └── voting-flow.spec.ts
└── src/test/
    └── setup.ts
```

### Running Tests

```bash
# Run all tests
npm test

# Run with UI
npm run test:ui

# Run tests once (CI mode)
npm run test:run

# Generate coverage report
npm run test:coverage

# Run E2E tests
npm run test:e2e

# Run E2E tests with UI
npm run test:e2e:ui
```

### Unit Tests

**Location:** `__tests__/unit/`

**Coverage:**
- Reputation score calculation
- Progressive rate limiting logic
- Anomaly detection algorithms
- Wallet flagging logic

**Example:**
```javascript
import {describe, it, expect} from 'vitest';

describe('Reputation System', () => {
  it('should calculate reputation score correctly', () => {
    const days = 10;
    const votes = 20;
    const score = Math.min(100, days * 2 + votes * 0.5);
    expect(score).toBe(30);
  });
});
```

### Integration Tests

**Location:** `__tests__/integration/`

**Coverage:**
- API endpoint functionality
- Request/response validation
- Error handling
- Authentication flows

**Example:**
```javascript
import request from 'supertest';

describe('API Tests', () => {
  it('should return health status', async () => {
    const res = await request(BASE_URL)
      .get('/api/health')
      .expect(200);
    expect(res.body).toHaveProperty('ok');
  });
});
```

### E2E Tests

**Location:** `e2e/`

**Coverage:**
- Full voting flow
- Wallet connection
- UI interactions
- Responsive design
- Error states

**Example:**
```typescript
test('should display transmission', async ({ page }) => {
  await page.goto('/');
  const transmission = page.locator('.txPrimary');
  await expect(transmission).toBeVisible();
});
```

### CI/CD Integration

**GitHub Actions Example:**

```yaml
name: Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: npm ci
      - run: npm run test:run
      - run: npm run test:e2e
```

### Coverage Goals

- **Unit Tests:** >80% coverage
- **Integration Tests:** All API endpoints
- **E2E Tests:** Critical user flows

---

## Configuration

### Environment Variables

**New Variables for Advanced Features:**

```bash
# Enable debug logging
DEBUG=true

# Anomaly detection thresholds (optional)
COORDINATED_THRESHOLD=5
RAPID_VOTE_THRESHOLD=3
BOT_IMMEDIATE_THRESHOLD_MS=5000

# Reputation system (optional)
REPUTATION_DECAY_DAYS=90
```

### Feature Flags

Control features via environment variables:

```bash
# Disable anomaly detection
ENABLE_ANOMALY_DETECTION=false

# Disable progressive rate limiting
ENABLE_PROGRESSIVE_RATE_LIMITING=false
```

---

## Monitoring & Alerts

### Key Metrics

1. **Reputation System:**
   - Average reputation score
   - Tier distribution
   - Time to tier upgrade

2. **Rate Limiting:**
   - Rate limit violations by tier
   - False positive rate
   - Average requests per wallet

3. **Anomaly Detection:**
   - Anomalies detected per cycle
   - False positive rate
   - Flagged wallet count

### Recommended Alerts

**Sentry/Datadog Alerts:**

```javascript
// High anomaly detection rate
if (anomaliesPerCycle > 10) {
  alert("High anomaly detection rate");
}

// Many flagged wallets
if (flaggedWallets > 20) {
  alert("Unusual number of flagged wallets");
}

// Reputation system degradation
if (avgReputationScore < 10) {
  alert("Low average reputation score");
}
```

### Dashboard Metrics

Create dashboards to track:
- Real-time rate limit violations
- Anomaly detection trends
- Reputation score distribution
- Flagged wallet history

---

## Troubleshooting

### Common Issues

#### 1. TypeScript Errors

**Problem:** Type errors when running `npm run build`

**Solution:**
```bash
# Check for errors
npm run type-check

# Install missing types
npm install @types/missing-package
```

#### 2. Rate Limiting Too Strict

**Problem:** Legitimate users getting rate limited

**Solution:**
- Check reputation scores in database
- Adjust tier thresholds in code
- Whitelist specific wallets

#### 3. False Positive Anomalies

**Problem:** Legitimate voting flagged as coordinated

**Solution:**
- Review detection thresholds
- Check vote timestamp distribution
- Manually unflag wallets in database

#### 4. Tests Failing

**Problem:** Tests fail after deployment

**Solution:**
```bash
# Check test environment
npm run test -- --reporter=verbose

# Update snapshots if needed
npm run test -- --updateSnapshot
```

### Support

For issues or questions:
- Check logs with `DEBUG=true`
- Review Firestore collections
- Contact: [your-email]

---

## Changelog

### Version 2.0.0 (2026-01-16)

**Added:**
- TypeScript support and configuration
- Progressive rate limiting system
- Anomaly detection system
- Comprehensive test suite
- Wallet reputation tracking
- Advanced monitoring capabilities

**Changed:**
- Rate limiting now wallet-based instead of IP-based
- Vote endpoint requires signature (breaking change)

**Fixed:**
- All Priority 1 and Priority 2 audit issues

---

## Future Enhancements

**Planned:**
- Machine learning-based anomaly detection
- Reputation decay over time
- Automated unflagging for minor violations
- Advanced analytics dashboard
- Real-time monitoring dashboard

---

**Last Updated:** 2026-01-16
**Version:** 2.0.0
**Maintainer:** Claude (Code Audit Agent)
