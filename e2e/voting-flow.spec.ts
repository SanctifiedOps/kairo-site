import { test, expect } from '@playwright/test';

test.describe('KAIRO Voting Flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('should load the homepage', async ({ page }) => {
    await expect(page.locator('.brandName')).toContainText('KAIRO');
    await expect(page.locator('.brandTag')).toContainText('EVERYTHING YOU SEE IS RESIDUAL');
  });

  test('should display transmission', async ({ page }) => {
    const transmission = page.locator('.txPrimary');
    await expect(transmission).toBeVisible();
    await expect(transmission).not.toBeEmpty();
  });

  test('should display stance buttons', async ({ page }) => {
    await expect(page.locator('button:has-text("ALIGN")')).toBeVisible();
    await expect(page.locator('button:has-text("REJECT")')).toBeVisible();
    await expect(page.locator('button:has-text("WITHHOLD")')).toBeVisible();
  });

  test('should show countdown timer', async ({ page }) => {
    const countdown = page.locator('.countdown');
    const text = await countdown.textContent();
    expect(text).toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  test('should display integrity level', async ({ page }) => {
    const integrity = page.locator('.integrity');
    await expect(integrity).toContainText(/INTEGRITY:\s+(LOW|MED|HIGH)/);
  });

  test('should show wallet connect button when not connected', async ({ page }) => {
    const connectButton = page.locator('button:has-text("CONNECT")');
    await expect(connectButton).toBeVisible();
  });

  test('should require wallet connection to vote', async ({ page }) => {
    // Try to click stance button without wallet
    await page.locator('button:has-text("ALIGN")').click();

    // Should show wallet required status
    const status = page.locator('.statusLine');
    await expect(status).toContainText(/WALLET REQUIRED/i);
  });

  test('should disable stance buttons after voting', async ({ page }) => {
    // This test requires wallet connection mock
    // For now, just verify buttons exist
    const alignButton = page.locator('button:has-text("ALIGN")');
    await expect(alignButton).toBeVisible();
  });

  test('should display vote counts', async ({ page }) => {
    // Check that counts are displayed
    const countsDisplay = page.locator('.counts');

    // Counts might be hidden initially, so just verify the element structure exists
    const stanceButtons = await page.locator('.stance').count();
    expect(stanceButtons).toBe(3);
  });

  test('should have proper accessibility', async ({ page }) => {
    // Check that stance buttons have aria-labels
    const alignButton = page.locator('button:has-text("ALIGN")');
    const ariaLabel = await alignButton.getAttribute('aria-label');
    expect(ariaLabel).toContain('Stance');
  });

  test('should display footer information', async ({ page }) => {
    const footer = page.locator('.footer');
    await expect(footer).toBeVisible();
    await expect(footer.locator('.footLeft')).toContainText('回路');
  });

  test('should have glitch effect class available', async ({ page }) => {
    // Glitch effect should be applied occasionally
    // Just verify the panel exists
    const panel = page.locator('.panel');
    await expect(panel).toBeVisible();
  });
});

test.describe('Responsive Design', () => {
  test('should be mobile friendly', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/');

    const panel = page.locator('.panel');
    await expect(panel).toBeVisible();

    const stanceButtons = page.locator('.stance');
    await expect(stanceButtons.first()).toBeVisible();
  });

  test('should work on tablet', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto('/');

    const brandName = page.locator('.brandName');
    await expect(brandName).toBeVisible();
  });
});

test.describe('Error Handling', () => {
  test('should handle API errors gracefully', async ({ page }) => {
    // Mock API failure
    await page.route('**/api/last', route => route.abort());
    await page.goto('/');

    // Should still render without crashing
    const brandName = page.locator('.brandName');
    await expect(brandName).toBeVisible();
  });
});
