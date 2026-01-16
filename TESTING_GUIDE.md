# KAIRO Testing Guide

Complete guide for running and writing tests for the KAIRO platform.

---

## Quick Start

```bash
# Install dependencies (if not already done)
npm install

# Run all tests
npm test

# Run tests with UI (recommended for development)
npm run test:ui

# Run E2E tests
npm run test:e2e
```

---

## Test Types

### 1. Unit Tests

**Purpose:** Test individual functions and logic in isolation

**Location:** `__tests__/unit/`

**What to test:**
- Reputation score calculations
- Rate limiting logic
- Anomaly detection algorithms
- Pure functions without side effects

**Example:**

```javascript
import {describe, it, expect} from 'vitest';

describe('Progressive Rate Limiting', () => {
  it('should return correct tier for new wallets', () => {
    const reputationScore = 5;
    // New tier: score < 20
    expect(reputationScore).toBeLessThan(20);
  });
});
```

**Running:**
```bash
npm test __tests__/unit
```

---

### 2. Integration Tests

**Purpose:** Test API endpoints and database interactions

**Location:** `__tests__/integration/`

**What to test:**
- HTTP endpoints
- Request/response formats
- Authentication/authorization
- Error handling

**Prerequisites:**
```bash
# Server must be running
npm run start:ts  # In separate terminal
```

**Example:**

```javascript
import request from 'supertest';

describe('POST /api/stance', () => {
  it('should reject vote without signature', async () => {
    const res = await request('http://localhost:8787')
      .post('/api/stance')
      .send({stance: 'ALIGN', wallet: 'test'})
      .expect(401);

    expect(res.body.error).toBe('SIGNATURE_REQUIRED');
  });
});
```

**Running:**
```bash
# Start server first
npm run start:ts

# In another terminal
npm test __tests__/integration
```

---

### 3. E2E Tests

**Purpose:** Test complete user flows in a real browser

**Location:** `e2e/`

**What to test:**
- Full voting flow
- Wallet connection
- UI interactions
- Mobile/responsive behavior
- Error states

**Example:**

```typescript
import {test, expect} from '@playwright/test';

test('should display transmission', async ({page}) => {
  await page.goto('/');
  const transmission = page.locator('.txPrimary');
  await expect(transmission).toBeVisible();
});
```

**Running:**
```bash
# Run all E2E tests
npm run test:e2e

# Run with UI (debug mode)
npm run test:e2e:ui

# Run specific test file
npx playwright test e2e/voting-flow.spec.ts

# Run in headed mode (see browser)
npx playwright test --headed
```

---

## Writing Tests

### Best Practices

1. **Name tests clearly:**
   ```javascript
   // Good
   it('should return 429 when rate limit exceeded')

   // Bad
   it('test rate limit')
   ```

2. **Test one thing per test:**
   ```javascript
   // Good
   it('should calculate reputation score correctly', () => {
     const score = calculateReputation(10, 20);
     expect(score).toBe(30);
   });

   // Bad (testing multiple things)
   it('should handle reputation', () => {
     const score = calculateReputation(10, 20);
     expect(score).toBe(30);
     const tier = getTier(score);
     expect(tier).toBe('regular');
     // Too much in one test
   });
   ```

3. **Use descriptive variable names:**
   ```javascript
   // Good
   const newWalletReputation = 5;
   const expectedTier = 'new';

   // Bad
   const x = 5;
   const y = 'new';
   ```

4. **Clean up after tests:**
   ```javascript
   afterEach(() => {
     // Reset state
     vi.clearAllMocks();
   });
   ```

### Test Structure

```javascript
describe('Feature Name', () => {
  describe('Sub-feature', () => {
    it('should do something specific', () => {
      // Arrange: Set up test data
      const input = 'test';

      // Act: Execute the function
      const result = functionUnderTest(input);

      // Assert: Verify the result
      expect(result).toBe('expected');
    });
  });
});
```

---

## Testing Progressive Rate Limiting

### Unit Test Example

```javascript
describe('getProgressiveRateLimit', () => {
  it('should return new tier for score < 20', () => {
    const limit = getProgressiveRateLimit(15);
    expect(limit.tier).toBe('new');
    expect(limit.maxRequests).toBe(3);
  });

  it('should return trusted tier for score >= 80', () => {
    const limit = getProgressiveRateLimit(90);
    expect(limit.tier).toBe('trusted');
    expect(limit.maxRequests).toBe(20);
  });
});
```

### Integration Test Example

```javascript
describe('Rate Limiting', () => {
  it('should block after exceeding limit', async () => {
    const wallet = 'test_wallet_123';

    // Make requests up to limit
    for(let i = 0; i < 3; i++) {
      await request(BASE_URL)
        .post('/api/test-endpoint')
        .send({wallet})
        .expect(200);
    }

    // Next request should be rate limited
    const res = await request(BASE_URL)
      .post('/api/test-endpoint')
      .send({wallet})
      .expect(429);

    expect(res.body.error).toBe('RATE_LIMIT');
  });
});
```

---

## Testing Anomaly Detection

### Coordinated Voting Test

```javascript
describe('Coordinated Voting Detection', () => {
  it('should detect when 5+ wallets vote same stance within 10s', () => {
    const votes = [
      {wallet: 'A', stance: 'ALIGN', timestampMs: 1000000},
      {wallet: 'B', stance: 'ALIGN', timestampMs: 1001000},
      {wallet: 'C', stance: 'ALIGN', timestampMs: 1002000},
      {wallet: 'D', stance: 'ALIGN', timestampMs: 1003000},
      {wallet: 'E', stance: 'ALIGN', timestampMs: 1004000},
    ];

    const timestamps = votes.map(v => v.timestampMs);
    const spread = Math.max(...timestamps) - Math.min(...timestamps);

    expect(votes.length).toBeGreaterThanOrEqual(5);
    expect(spread).toBeLessThan(10000);
  });
});
```

### Bot Behavior Test

```javascript
describe('Bot Behavior Detection', () => {
  it('should flag immediate voting after cycle start', () => {
    const cycleStartMs = 1000000;
    const voteTimestampMs = 1003000; // 3 seconds later
    const timeSinceCycleStart = voteTimestampMs - cycleStartMs;

    expect(timeSinceCycleStart).toBeLessThan(5000); // Suspicious
  });
});
```

---

## E2E Testing

### Voting Flow Test

```typescript
test('complete voting flow', async ({page}) => {
  // Navigate to homepage
  await page.goto('/');

  // Verify transmission is loaded
  await expect(page.locator('.txPrimary')).toBeVisible();

  // Click wallet connect (if implemented)
  await page.locator('button:has-text("CONNECT")').click();

  // Select wallet (mock)
  // ... wallet selection logic ...

  // Click stance button
  await page.locator('button:has-text("ALIGN")').click();

  // Verify vote recorded
  await expect(page.locator('.statusLine'))
    .toContainText(/RECORDED/i);

  // Verify button disabled
  await expect(page.locator('button:has-text("ALIGN")'))
    .toBeDisabled();
});
```

### Mobile Responsive Test

```typescript
test('should be mobile friendly', async ({page}) => {
  await page.setViewportSize({width: 375, height: 667});
  await page.goto('/');

  // Verify key elements are visible
  await expect(page.locator('.brandName')).toBeVisible();
  await expect(page.locator('.panel')).toBeVisible();
  await expect(page.locator('.stance').first()).toBeVisible();
});
```

---

## Coverage

### Viewing Coverage

```bash
# Generate coverage report
npm run test:coverage

# Open HTML report
open coverage/index.html  # macOS
xdg-open coverage/index.html  # Linux
start coverage/index.html  # Windows
```

### Coverage Goals

- **Overall:** >80%
- **Unit Tests:** >90%
- **Integration Tests:** All endpoints
- **E2E Tests:** Critical flows

### Improving Coverage

1. **Identify uncovered code:**
   ```bash
   npm run test:coverage
   # Check coverage/index.html for red sections
   ```

2. **Add tests for uncovered lines:**
   ```javascript
   it('should handle edge case', () => {
     // Test the previously uncovered code path
   });
   ```

3. **Focus on critical paths first:**
   - Voting logic
   - Reputation calculations
   - Anomaly detection
   - Rate limiting

---

## CI/CD Integration

### GitHub Actions Example

```yaml
name: Tests

on:
  push:
    branches: [main, develop]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v3

      - uses: actions/setup-node@v3
        with:
          node-version: '18'
          cache: 'npm'

      - run: npm ci

      - name: Run unit tests
        run: npm run test:run

      - name: Run E2E tests
        run: npm run test:e2e

      - name: Upload coverage
        uses: codecov/codecov-action@v3
        with:
          files: ./coverage/coverage-final.json
```

---

## Debugging Tests

### Vitest Debugging

```bash
# Run tests in debug mode
node --inspect-brk ./node_modules/.bin/vitest

# Run specific test file
npm test -- reputation.test.js

# Run tests matching pattern
npm test -- --grep "rate limit"

# Update snapshots
npm test -- --updateSnapshot
```

### Playwright Debugging

```bash
# Run with UI (best for debugging)
npm run test:e2e:ui

# Run in headed mode
npx playwright test --headed

# Debug specific test
npx playwright test --debug voting-flow.spec.ts

# Show browser
npx playwright test --headed --slowMo=1000
```

### Common Issues

#### 1. Tests timing out

```javascript
// Increase timeout
test('slow test', async () => {
  // ...
}, {timeout: 10000}); // 10 seconds
```

#### 2. Flaky tests

```javascript
// Add retries
test('flaky test', async () => {
  // ...
}, {retry: 2});
```

#### 3. Mock not working

```javascript
// Clear mocks between tests
afterEach(() => {
  vi.clearAllMocks();
});
```

---

## Test Data

### Creating Test Data

```javascript
// Use factories for consistent test data
function createMockWallet(overrides = {}) {
  return {
    address: 'test_wallet_123',
    reputationScore: 50,
    flagged: false,
    ...overrides
  };
}

// Use in tests
it('should handle flagged wallet', () => {
  const wallet = createMockWallet({flagged: true});
  // ...
});
```

### Database Fixtures

For integration tests, use test database:

```javascript
beforeEach(async () => {
  // Set up test database
  await setupTestDb();
  await seedTestData();
});

afterEach(async () => {
  // Clean up
  await clearTestDb();
});
```

---

## Performance Testing

### Load Testing

Use Artillery or k6 for load testing:

```yaml
# artillery.yml
config:
  target: 'http://localhost:8787'
  phases:
    - duration: 60
      arrivalRate: 10

scenarios:
  - name: 'Vote'
    flow:
      - post:
          url: '/api/stance'
          json:
            stance: 'ALIGN'
            wallet: '{{ $randomString() }}'
```

Run:
```bash
npx artillery run artillery.yml
```

---

## Resources

- [Vitest Documentation](https://vitest.dev/)
- [Playwright Documentation](https://playwright.dev/)
- [Testing Library](https://testing-library.com/)
- [Jest DOM Matchers](https://github.com/testing-library/jest-dom)

---

## Getting Help

If tests are failing:

1. Check test output for specific error
2. Run with `--reporter=verbose` for details
3. Use debugging tools (UI mode)
4. Check if server is running (for integration tests)
5. Verify environment variables are set

---

**Last Updated:** 2026-01-16
**Version:** 2.0.0
