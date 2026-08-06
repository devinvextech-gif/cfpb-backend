const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

// CORS — allow Vite dev server and same-origin requests
app.use((req, res, next) => {
  const allowed = ['http://localhost:5173', 'http://127.0.0.1:5173'];
  const origin = req.headers.origin;
  if (allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Session state ─────────────────────────────────────────────────────────────
let session = {
  active: false,
  status: 'idle',
  browser: null,
  page: null,
  keepAliveTimer: null,
  keepAliveExpiry: null,
  dashboardData: null,
  error: null,
  verifyError: null,   // inline error from the verify page (bad code)
};

function clearSession() {
  if (session.keepAliveTimer) clearInterval(session.keepAliveTimer);
  if (session.browser) session.browser.close().catch(() => { });
  session = {
    active: false,
    status: 'idle',
    browser: null,
    page: null,
    keepAliveTimer: null,
    keepAliveExpiry: null,
    dashboardData: null,
    error: null,
    verifyError: null,
  };
}

// Keep session alive by interacting with the page every 30 s
function startKeepAlive(page) {
  const KEEP_ALIVE_DURATION_MS = 20 * 60 * 1000; // 20 minutes
  session.keepAliveExpiry = new Date(Date.now() + KEEP_ALIVE_DURATION_MS);

  session.keepAliveTimer = setInterval(async () => {
    // Stop if session was cleared or verification already done
    if (!session.active || session.status === 'done' || session.status === 'error') {
      clearInterval(session.keepAliveTimer);
      return;
    }
    // Auto-expire after 20 minutes
    if (Date.now() > session.keepAliveExpiry) {
      console.log('[keep-alive] 20-minute window expired, closing session');
      session.status = 'error';
      session.error = 'Session expired: 20-minute verification window elapsed.';
      session.active = false;
      clearInterval(session.keepAliveTimer);
      if (session.browser) session.browser.close().catch(() => { });
      return;
    }
    try {
      // Light interaction to keep session alive: move mouse or evaluate
      await page.evaluate(() => document.title);
      console.log('[keep-alive] ping OK at', new Date().toISOString());
    } catch (e) {
      console.warn('[keep-alive] ping failed:', e.message);
    }
  }, 30_000);
}

// ── POST /start ───────────────────────────────────────────────────────────────
// Launches browser, logs in, waits on verify page, starts keep-alive
app.post('/start', async (req, res) => {
  if (session.active) {
    return res.status(409).json({ error: 'A session is already active. Only one session allowed at a time.' });
  }

  session.active = true;
  session.status = 'launching';
  session.error = null;
  session.verifyError = null;
  session.dashboardData = null;

  res.json({ message: 'Session starting…' });

  // Run async — frontend polls /status
  (async () => {
    try {
      console.log('[start] Launching browser…');
      session.browser = await chromium.launch({ headless: true });
      const context = await session.browser.newContext({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      });
      session.page = await context.newPage();

      // The CFPB portal redirects to the real login page automatically
      console.log('[start] Navigating to login page…');
      await session.page.goto('https://portal.consumerfinance.gov/company/s/login/', {
        waitUntil: 'networkidle',
        timeout: 60_000,
      });
      console.log('[start] Landed on:', session.page.url());

      // Fill email — Salesforce uses dynamic IDs; target by placeholder
      console.log('[start] Filling email…');
      await session.page.waitForSelector('input[placeholder="Email Address"]', { timeout: 30_000 });
      await session.page.fill('input[placeholder="Email Address"]', 'usman.m@waypoint.com');

      // Fill password
      console.log('[start] Filling password…');
      await session.page.waitForSelector('input[placeholder="Password"]', { timeout: 15_000 });
      await session.page.fill('input[placeholder="Password"]', 'Team2026!!Team2026!!');

      // Click Log in button
      console.log('[start] Submitting login…');
      await session.page.click('button.sfdc_button, button:has-text("Log in")');

      // Wait for either: MFA/verify page OR dashboard (in case MFA is skipped)
      console.log('[start] Waiting for post-login redirect…');
      await session.page.waitForURL(
        (url) => !url.toString().includes('/login'),
        { timeout: 60_000 }
      );
      console.log('[start] Redirected to:', session.page.url());

      // Detect where we landed: MFA/verify page or directly on dashboard
      const postLoginUrl = session.page.url();
      const onVerifyPage = /TotpVerification|verify|mfa|otp|two-factor|totp|challenge/i.test(postLoginUrl);

      if (onVerifyPage) {
        console.log('[start] On verification page, starting keep-alive…');
        session.status = 'waiting_verify';
        startKeepAlive(session.page);
      } else {
        // Landed directly on dashboard — no MFA needed, scrape immediately
        console.log('[start] No MFA required, scraping dashboard…');
        session.status = 'scraping';
        const data = await scrapeDashboard(session.page);
        session.dashboardData = data;
        session.status = 'done';
        session.active = false;
        if (session.browser) session.browser.close().catch(() => { });
      }
    } catch (err) {
      console.error('[start] Error:', err.message);
      session.status = 'error';
      session.error = err.message;
      session.active = false;
      if (session.browser) session.browser.close().catch(() => { });
    }
  })();
});

// ── POST /verify ──────────────────────────────────────────────────────────────
// Receives OTP code, enters it in the active Playwright session
app.post('/verify', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code is required' });
  if (!session.active) return res.status(409).json({ error: 'No active session' });
  if (session.status !== 'waiting_verify') {
    return res.status(409).json({ error: `Session is in state "${session.status}", not waiting for code` });
  }

  session.status = 'verifying';
  session.verifyError = null;
  res.json({ message: 'Verification code received, processing…' });

  (async () => {
    try {
      const page = session.page;

      // Enter the OTP code — input#tc, maxlength 6
      console.log('[verify] Entering OTP code…');
      await page.waitForSelector('input#tc', { timeout: 15_000 });
      // Clear field first then type
      await page.fill('input#tc', '');
      await page.fill('input#tc', code.trim().slice(0, 6));

      // Submit — <input type="submit" id="save" value="Verify">
      // The form does a full POST navigation, so we race:
      //   A) page navigates away from TotpVerification  → success
      //   B) page stays on TotpVerification (reloads with error) → bad code
      console.log('[verify] Submitting code…');

      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }),
        page.click('input[type="submit"]#save'),
      ]);

      const currentUrl = page.url();
      console.log('[verify] After submit URL:', currentUrl);

      if (currentUrl.includes('TotpVerification')) {
        // Page reloaded with an error — read the exact error text from the site
        const errorText = await page.evaluate(() => {
          const el = document.getElementById('tc-error');
          return el ? el.innerText.trim() : null;
        });
        const msg = errorText || 'Invalid or expired verification code. Try again.';
        console.log('[verify] Bad code:', msg);
        session.status = 'waiting_verify';   // allow user to retry
        session.verifyError = msg;
      } else {
        // Navigated away — success, scrape dashboard
        await handleVerifySuccess(page);
      }
    } catch (err) {
      console.error('[verify] Error:', err.message);
      session.status = 'error';
      session.error = err.message;
      session.active = false;
      if (session.keepAliveTimer) clearInterval(session.keepAliveTimer);
    }
  })();
});

// ── Handle successful verification ───────────────────────────────────────────
async function handleVerifySuccess(page) {
  console.log('[verify] Success! Landed on:', page.url());
  if (session.keepAliveTimer) clearInterval(session.keepAliveTimer);
  session.verifyError = null;
  session.status = 'scraping';
  const data = await scrapeDashboard(page);
  session.dashboardData = data;
  session.status = 'done';
  session.active = false;
  console.log('[verify] Done. Dashboard data scraped.');
}

// ── Dashboard scraper ─────────────────────────────────────────────────────────
async function scrapeDashboard(page) {
  try {
    await page.waitForLoadState('networkidle', { timeout: 30_000 });
  } catch (_) { /* best effort */ }

  const dashboardUrl = page.url();
  console.log('[scrapeDashboard] Landed on dashboard:', dashboardUrl);

  // Extract the dashboard summary cards (e.g., active, past due, unread) just in case
  const dashboardSummary = await page.evaluate(() => {
    return [...document.querySelectorAll('article, .forceCommunityTileMenu, .slds-card, [class*="card"], [class*="tile"]')]
      .map(c => c.innerText.trim())
      .filter(Boolean);
  });

  console.log('[scrapeDashboard] Clicking Complaints tab...');
  try {
    // Attempt to click the Complaints tab in the navigation menu
    await page.click('a:has-text("Complaints"), a[title="Complaints"]', { timeout: 15_000 });
    await page.waitForLoadState('networkidle', { timeout: 30_000 });
    console.log('[scrapeDashboard] Navigated to Complaints tab:', page.url());
    
    // Wait a bit to ensure the data table is rendered
    await page.waitForTimeout(5000);
  } catch (err) {
    console.warn('[scrapeDashboard] Could not click "Complaints" tab or wait for load:', err.message);
  }

  const url = page.url();
  const title = await page.title();

  // Grab all visible text blocks, headings, links, and table data
  const raw = await page.evaluate(() => {
    const getText = (selector) =>
      [...document.querySelectorAll(selector)].map((el) => el.innerText.trim()).filter(Boolean);

    const getLinks = () =>
      [...document.querySelectorAll('a[href]')].map((a) => ({
        text: a.innerText.trim(),
        href: a.href,
      })).filter((l) => l.text);

    const getTables = () =>
      [...document.querySelectorAll('table')].map((t) => {
        const headers = [...t.querySelectorAll('th')].map((h) => h.innerText.trim());
        const rows = [...t.querySelectorAll('tr')].map((r) =>
          [...r.querySelectorAll('td')].map((d) => d.innerText.trim())
        ).filter((r) => r.length > 0);
        return { headers, rows };
      });

    return {
      headings: getText('h1, h2, h3'),
      paragraphs: getText('p'),
      lists: getText('li'),
      links: getLinks(),
      tables: getTables(),
      bodyText: document.body.innerText.slice(0, 5000), // first 5k chars
    };
  });

  return { url, title, scrapedAt: new Date().toISOString(), dashboardSummary, ...raw };
}

// ── GET /status ───────────────────────────────────────────────────────────────
app.get('/status', (req, res) => {
  const secondsLeft = session.keepAliveExpiry
    ? Math.max(0, Math.round((session.keepAliveExpiry - Date.now()) / 1000))
    : null;

  res.json({
    active: session.active,
    status: session.status,
    error: session.error,
    verifyError: session.verifyError,
    keepAliveSecondsLeft: secondsLeft,
    dashboardData: session.dashboardData,
  });
});

// ── POST /reset ───────────────────────────────────────────────────────────────
app.post('/reset', (req, res) => {
  clearSession();
  res.json({ message: 'Session cleared' });
});

// ── Start server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`CFPB backend listening on http://localhost:${PORT}`));
