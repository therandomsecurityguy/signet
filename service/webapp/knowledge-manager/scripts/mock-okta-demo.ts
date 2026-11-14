import { chromium } from 'playwright';

function getOrigin() {
  const value = process.env.WEBAPP_ORIGIN ?? 'http://localhost:3200';
  return new URL(value).toString();
}

function getHeadless() {
  return process.env.HEADLESS !== 'false';
}

async function main() {
  const origin = getOrigin();
  const browser = await chromium.launch({ headless: getHeadless() });
  const page = await browser.newPage();

  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });

    const loginButton = page.getByRole('button', { name: 'Start mock Okta session' });
    if (!(await loginButton.isVisible().catch(() => false))) {
      throw new Error(
        'Mock Okta login button not found. Ensure the webapp is reachable and configured with OKTA_MODE=mock.',
      );
    }

    await loginButton.click();
    await page.waitForURL((url) => url.origin === new URL(origin).origin, { timeout: 10_000 });
    await page.getByRole('button', { name: 'Logout' }).waitFor({ timeout: 10_000 });

    await page.goto(new URL('/agents', origin).toString(), { waitUntil: 'domcontentloaded' });
    await page.getByText('Agents', { exact: true }).waitFor({ timeout: 10_000 });

    await page.goto(new URL('/skills', origin).toString(), { waitUntil: 'domcontentloaded' });
    await page.getByText('Skills', { exact: true }).waitFor({ timeout: 10_000 });

    await page.getByRole('button', { name: 'Logout' }).click();
    await page.getByRole('button', { name: 'Start mock Okta session' }).waitFor({ timeout: 10_000 });

    console.log(
      JSON.stringify(
        {
          ok: true,
          origin,
          verified: ['mock login button', 'session established', 'agents page', 'skills page', 'logout'],
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
  }
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
