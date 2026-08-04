export async function acceptConfiguredLoginTerms(page, origin, config = {}) {
  if (!(config.autoAcceptUpdatedTermsOrigins ?? []).includes(origin)) return false;
  const accept = page.getByRole("button", { name: "同意并继续", exact: true });
  if (await accept.count() !== 1 || !await accept.isVisible().catch(() => false)) return false;
  await accept.click({ timeout: 10000 });
  await page.waitForTimeout(Math.max(500, Number(config.actionWaitMs) || 0));
  return true;
}

export async function waitForLoginSubmitEnabled(page, submit, origin, config = {}) {
  if (await submit.isEnabled().catch(() => false)) return true;
  if (!(config.autoClickTurnstileOrigins ?? []).includes(origin)) return false;

  const timeoutMs = Math.max(10000, Math.min(90000, Number(config.cloudflareWaitMs) || 60000));
  const deadline = Date.now() + timeoutMs;
  let challengeClicked = false;
  while (Date.now() < deadline) {
    if (await submit.isEnabled().catch(() => false)) return true;
    if (!challengeClicked) {
      const capButton = page.getByRole("button", { name: /确认.*真人|真人.*确认/ });
      if (await capButton.count().catch(() => 0) === 1 && await capButton.isVisible().catch(() => false)) {
        await capButton.click({ timeout: 5000 }).catch(() => {});
        challengeClicked = true;
      } else {
        const capWidget = page.locator("cap-widget:visible, [data-cap-api-endpoint]:visible");
        if (await capWidget.count().catch(() => 0) === 1) {
          await capWidget.click({ timeout: 5000 }).catch(() => {});
          challengeClicked = true;
        } else {
          const frame = page.frameLocator('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile" i]');
          const checkbox = frame.locator('input[type="checkbox"]');
          if (await checkbox.count().catch(() => 0) === 1) {
            await checkbox.click({ timeout: 5000 }).catch(() => {});
            challengeClicked = true;
          }
        }
      }
    }
    await page.waitForTimeout(1000);
  }
  return submit.isEnabled().catch(() => false);
}
