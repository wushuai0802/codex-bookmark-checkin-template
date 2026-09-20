export async function resumeSingleGoogleAccount(page, state, { isolatedIdentity = false } = {}) {
  if (!isolatedIdentity || state.attempted) return false;
  let url;
  try { url = new URL(page.url()); } catch { return false; }
  if (url.origin !== "https://accounts.google.com"
    || !/^\/(?:v\d+\/)?signin\/accountchooser\/?$/i.test(url.pathname)) return false;
  if (await page.locator('input[type="email"]:visible, input[type="password"]:visible').count()) return false;
  // Reuse only the sole existing account in an isolated identity profile.
  // Never expose its email, enter credentials, or accept an OAuth consent page.
  const choice = page.locator('[role="link"][data-identifier][data-authuser]:visible');
  if (await choice.count() !== 1 || !await choice.isEnabled()) return false;
  state.attempted = true;
  await choice.click({ timeout: 10000 });
  return true;
}
