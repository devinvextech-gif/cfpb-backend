const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  console.log('Navigating to login...');
  await page.goto('https://portal.consumerfinance.gov/company/s/login/', { waitUntil: 'networkidle', timeout: 60000 });

  console.log('Filling credentials...');
  await page.waitForSelector('input[placeholder="Email Address"]', { timeout: 30000 });
  await page.fill('input[placeholder="Email Address"]', 'usman.m@waypoint.com');
  await page.waitForSelector('input[placeholder="Password"]', { timeout: 15000 });
  await page.fill('input[placeholder="Password"]', 'Team2026!!Team2026!!');

  console.log('Clicking login...');
  await page.click('button.sfdc_button, button:has-text("Log in")');

  console.log('Waiting for redirect...');
  await page.waitForURL(url => !url.toString().includes('/login'), { timeout: 60000 });
  console.log('Redirected to:', page.url());

  const postLoginUrl = page.url();
  const onVerifyPage = /TotpVerification|verify|mfa|otp|two-factor|totp|challenge/i.test(postLoginUrl);

  if (onVerifyPage) {
    console.log('MFA required, cannot proceed automatically.');
  } else {
    console.log('No MFA, on dashboard.');
    try {
      await page.waitForLoadState('networkidle', { timeout: 30000 });
    } catch (e) { }

    console.log('Clicking Complaints...');
    try {
      await page.click('a:has-text("Complaints")', { timeout: 15000 });
      await page.waitForLoadState('networkidle', { timeout: 30000 });
      console.log('On Complaints page:', page.url());

      // Wait a bit for the data table to load
      await page.waitForTimeout(5000);

      // Extract headers and first row to see structure
      const data = await page.evaluate(() => {
        const getTables = () =>
          [...document.querySelectorAll('table')].map((t) => {
            const headers = [...t.querySelectorAll('th')].map((h) => h.innerText.trim());
            const rows = [...t.querySelectorAll('tr')].map((r) =>
              [...r.querySelectorAll('td')].map((d) => d.innerText.trim())
            ).filter((r) => r.length > 0);
            return { headers, rows: rows.slice(0, 3) }; // just first 3 rows
          });
        return {
          tables: getTables(),
          headings: [...document.querySelectorAll('h1, h2, h3')].map(el => el.innerText.trim()),
          links: [...document.querySelectorAll('a')].map(a => a.innerText.trim()).filter(t => t.length > 0).slice(0, 20)
        };
      });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      console.error('Error clicking complaints or extracting:', err);
    }
  }

  await browser.close();
})();
