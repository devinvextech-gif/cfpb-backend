require('dotenv').config();

const { chromium } = require('playwright');
const readline = require('readline');

const CFPB_EMAIL = process.env.CFPB_EMAIL;
const CFPB_PASSWORD = process.env.CFPB_PASSWORD;

if (!CFPB_EMAIL || !CFPB_PASSWORD) {
  throw new Error('CFPB_EMAIL and CFPB_PASSWORD must be configured');
}

/**
 * Prompts the user in the terminal and waits for their input.
 * @param {string} question - The prompt to display.
 * @returns {Promise<string>} - The entered text.
 */
function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Checks if the current page is the email verification screen.
 * Looks for the specific input field used in the CFPB 2FA email flow.
 * The input has a pre-filled prefix like "JFH-" (3 letters + dash).
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>}
 */
async function isEmailVerificationScreen(page) {
  try {
    // The email code input field has this specific ID in the page source
    const inputEl = await page.$('#thePage\\:j_id2\\:i\\:f\\:pb\\:d\\:CodeInput\\.input');
    if (inputEl) return true;

    // Fallback: look for the "Enter your verification code" heading text
    const bodyText = await page.textContent('body').catch(() => '');
    if (bodyText.includes('Enter your verification code') && bodyText.includes('emailed to you')) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

(async () => {
  const browser = await chromium.launch({ headless: false }); // headless:false so you can see the screen
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  // ─── Step 1: Navigate & Login ──────────────────────────────────────────────
  console.log('\n[1/4] Navigating to login page...');
  await page.goto('https://portal.consumerfinance.gov/company/s/login/', { waitUntil: 'networkidle', timeout: 60000 });

  console.log('[1/4] Filling credentials...');
  await page.waitForSelector('input[placeholder="Email Address"]', { timeout: 30000 });
  await page.fill('input[placeholder="Email Address"]', CFPB_EMAIL);
  await page.waitForSelector('input[placeholder="Password"]', { timeout: 15000 });
  await page.fill('input[placeholder="Password"]', CFPB_PASSWORD);

  console.log('[1/4] Submitting login...');
  await page.click('button.sfdc_button, button:has-text("Log in")');

  // Wait for navigation away from the login page
  await page.waitForURL(url => !url.toString().includes('/login'), { timeout: 60000 });
  console.log('[1/4] Redirected to:', page.url());

  // ─── Step 2: Handle TOTP / First MFA (authenticator app) ──────────────────
  const postLoginUrl = page.url();
  const onTotpPage = /TotpVerification|verify|mfa|otp|two-factor|totp|challenge/i.test(postLoginUrl);

  if (onTotpPage) {
    console.log('[2/4] TOTP/Authenticator MFA screen detected — cannot auto-handle, exiting.');
    await browser.close();
    return;
  }

  // ─── Step 3: Handle Email Verification (2nd factor, first login of the day) ─
  // After the password step the portal may redirect to the loginFlow page to ask
  // for an emailed code.  We wait a moment then check.
  console.log('[3/4] Checking for email verification screen...');
  await page.waitForTimeout(3000); // give the page a moment to settle

  const emailVerifyNeeded = await isEmailVerificationScreen(page);

  if (emailVerifyNeeded) {
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║        EMAIL VERIFICATION CODE REQUIRED                 ║');
    console.log('╚══════════════════════════════════════════════════════════╝');

    // Read the prefix that is already pre-filled in the input (e.g. "JFH-")
    let prefixValue = '';
    try {
      const inputEl = await page.$('#thePage\\:j_id2\\:i\\:f\\:pb\\:d\\:CodeInput\\.input');
      if (inputEl) {
        prefixValue = await inputEl.inputValue();
      }
    } catch {
      // If selector didn't work, try the name attribute fallback
      try {
        prefixValue = await page.inputValue('[name="thePage:j_id2:i:f:pb:d:element___input____CodeInput"]');
      } catch { /* ignore */ }
    }

    if (prefixValue) {
      console.log(`\n  The page shows a pre-filled prefix: "${prefixValue}"`);
      console.log(`  Check your inbox at ${CFPB_EMAIL} for an email from the CFPB portal.`);
      console.log(`  The code in the email will START with: "${prefixValue}"\n`);
    } else {
      console.log(`\n  Check your inbox at ${CFPB_EMAIL} for an email from the CFPB portal.`);
      console.log('  The code will have a short letter prefix shown on screen.\n');
    }

    // Prompt the user to enter the full code from the email
    const emailCode = await prompt('  >>> Paste the FULL verification code from your email (e.g. JFH-123456): ');

    if (!emailCode) {
      console.error('No code entered. Aborting.');
      await browser.close();
      return;
    }

    console.log(`\n[3/4] Entering email verification code: "${emailCode}"...`);

    // Clear the input and type the full code
    try {
      const inputEl = await page.$('#thePage\\:j_id2\\:i\\:f\\:pb\\:d\\:CodeInput\\.input');
      if (inputEl) {
        await inputEl.click({ clickCount: 3 }); // select all
        await inputEl.fill(emailCode);
      } else {
        // Fallback: use name selector
        await page.click('[name="thePage:j_id2:i:f:pb:d:element___input____CodeInput"]', { clickCount: 3 });
        await page.fill('[name="thePage:j_id2:i:f:pb:d:element___input____CodeInput"]', emailCode);
      }
    } catch (err) {
      console.error('Could not fill the code input:', err.message);
      await browser.close();
      return;
    }

    // Click the "Next" button to submit the code
    console.log('[3/4] Clicking Next to submit the code...');
    try {
      // The Next button has this specific ID from the page source
      await page.click('#thePage\\:j_id2\\:i\\:f\\:pb\\:pbb\\:nextAjax');
    } catch {
      // Fallback: find by value or text
      await page.click('input[value="Next"], button:has-text("Next")');
    }

    // Wait for the portal to process the code and navigate away
    await page.waitForURL(url => !url.toString().includes('loginFlow'), { timeout: 60000 });
    console.log('[3/4] Email verification complete! Now at:', page.url());

    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  } else {
    console.log('[3/4] No email verification screen detected — continuing.');
  }

  // ─── Step 4: Navigate to Complaints ────────────────────────────────────────
  console.log('\n[4/4] Looking for Complaints link...');
  try {
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.click('a:has-text("Complaints")', { timeout: 15000 });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    console.log('[4/4] On Complaints page:', page.url());

    // Wait for the data table to load
    await page.waitForTimeout(5000);

    // Extract table structure
    const data = await page.evaluate(() => {
      const getTables = () =>
        [...document.querySelectorAll('table')].map((t) => {
          const headers = [...t.querySelectorAll('th')].map((h) => h.innerText.trim());
          const rows = [...t.querySelectorAll('tr')].map((r) =>
            [...r.querySelectorAll('td')].map((d) => d.innerText.trim())
          ).filter((r) => r.length > 0);
          return { headers, rows: rows.slice(0, 3) };
        });
      return {
        tables: getTables(),
        headings: [...document.querySelectorAll('h1, h2, h3')].map(el => el.innerText.trim()),
        links: [...document.querySelectorAll('a')].map(a => a.innerText.trim()).filter(t => t.length > 0).slice(0, 20),
      };
    });
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[4/4] Error navigating to Complaints:', err.message);
  }

  await browser.close();
  console.log('\nDone.');
})();

