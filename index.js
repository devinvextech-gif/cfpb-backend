require('dotenv').config();
const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());
const APP_VERSION = '2fa-email-flow-2026-08-21-3';
const CFPB_EMAIL = process.env.CFPB_EMAIL?.trim();
const CFPB_PASSWORD = process.env.CFPB_PASSWORD;

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
  emailVerifyError: null,
  emailCodePrefix: null,
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
    emailVerifyError: null,
    emailCodePrefix: null,
  };
}

async function getVerificationState(page) {
  return page.evaluate(() => {
    const bodyText = document.body?.innerText || '';
    const hasCodeInput = Boolean(document.querySelector(
      'input#tc, input[name="tc"], input[id*="code" i][type="text"], input[autocomplete="one-time-code"]'
    ));
    const emailChallenge = /first\s*3\s*letters|match the first|email verification|sent[\s\S]{0,120}email|code in your email/i.test(bodyText);
    return {
      isVerificationPage: Boolean(hasCodeInput || /enter your verification code/i.test(bodyText)),
      isEmailChallenge: emailChallenge,
      emailCodePrefix: bodyText.match(/first 3 letters[^\n]*?\b([A-Za-z]{3})\b/i)?.[1] || null,
    };
  });
}

// Guard against any exception we didn't anticipate crashing the whole process
function failSession(label, err) {
  console.error(`[fatal] ${label}:`, err);
  if (session.keepAliveTimer) clearInterval(session.keepAliveTimer);
  if (session.browser) session.browser.close().catch(() => { });
  session.status = 'error';
  session.error = `Internal error: ${err && err.message ? err.message : err}`;
  session.active = false;
}

process.on('uncaughtException', (err) => failSession('Uncaught exception', err));
process.on('unhandledRejection', (reason) => failSession('Unhandled rejection', reason));

async function sendToN8n(payload) {
  const webhookUrl = process.env.N8N_WEBHOOK_URL?.trim();

  if (!webhookUrl) {
    const error = 'N8N_WEBHOOK_URL is not configured in the backend environment.';
    console.error(`[n8n] ${error}`);
    return { ok: false, error };
  }

  try {
    const jsonPayload = JSON.stringify(payload);
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: jsonPayload,
    });

    const responseText = await response.text();
    console.log(`[n8n] Webhook status: ${response.status}; payload size: ${Buffer.byteLength(jsonPayload)} bytes.`);

    return { ok: response.ok, status: response.status, responseText };
  } catch (err) {
    console.error('[n8n] Failed to send payload:', err.message);
    return { ok: false, error: err.message };
  }
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
  session.emailVerifyError = null;
  session.emailCodePrefix = null;
  session.dashboardData = null;

  res.json({ message: 'Session starting…' });

  // Run async — frontend polls /status
  (async () => {
    try {
      if (!CFPB_EMAIL || !CFPB_PASSWORD) {
        throw new Error('CFPB_EMAIL and CFPB_PASSWORD must be configured in the backend environment.');
      }
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
      console.log('[start] Login page loaded.');

      // Fill email — Salesforce uses dynamic IDs; target by placeholder
      console.log('[start] Filling email…');
      await session.page.waitForSelector('input[placeholder="Email Address"]', { timeout: 30_000 });
      await session.page.fill('input[placeholder="Email Address"]', CFPB_EMAIL);

      // Fill password
      console.log('[start] Filling password…');
      await session.page.waitForSelector('input[placeholder="Password"]', { timeout: 15_000 });
      await session.page.fill('input[placeholder="Password"]', CFPB_PASSWORD);

      // Click Log in button
      console.log('[start] Submitting login…');
      await session.page.click('button.sfdc_button, button:has-text("Log in")');

      // Wait for either: MFA/verify page OR dashboard (in case MFA is skipped)
      console.log('[start] Waiting for post-login redirect…');
      await session.page.waitForURL(
        (url) => !url.toString().includes('/login'),
        { timeout: 60_000 }
      );
      console.log('[start] Post-login page loaded.');

      // Detect where we landed: MFA/verify page or directly on dashboard
      const postLoginUrl = session.page.url();
      const onVerifyPage = /TotpVerification|loginflow|verify|mfa|otp|two-factor|totp|challenge/i.test(postLoginUrl);

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
        clearSession();
        session.dashboardData = data;
        session.status = 'done';
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

      // Render can take longer to hydrate the CFPB login-flow form.
      console.log('[verify] Entering OTP code…');
      await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
      const codeInput = page.locator('input#tc:visible, input[name="tc"]:visible, input[id*="code" i][type="text"]:visible, input[autocomplete="one-time-code"]:visible');
      try {
        await codeInput.first().waitFor({ state: 'visible', timeout: 30_000 });
      } catch (err) {
        const diagnostics = await page.evaluate(() => ({
          url: window.location.href,
          title: document.title,
          inputs: [...document.querySelectorAll('input')].map((input) => ({
            id: input.id,
            name: input.name,
            type: input.type,
            visible: Boolean(input.offsetWidth || input.offsetHeight || input.getClientRects().length),
          })),
          bodyText: (document.body?.innerText || '').trim().slice(0, 300),
        })).catch(() => ({ url: page.url(), title: '', inputs: [], bodyText: '' }));
        throw new Error(`Verification form was not ready. Page: ${diagnostics.title} (${diagnostics.url}); inputs=${JSON.stringify(diagnostics.inputs)}; body="${diagnostics.bodyText}"`);
      }

      // Clear field first then type
      await codeInput.first().fill('');
      await codeInput.first().fill(code.trim().slice(0, 6));

      // Submit — <input type="submit" id="save" value="Verify">
      // The form does a full POST navigation, so we race:
      //   A) page navigates away from TotpVerification  → success
      //   B) page stays on TotpVerification (reloads with error) → bad code
      console.log('[verify] Submitting code…');

      await page.click('input[type="submit"]#save');

      // Safely wait for either navigation away from the verify page OR an error message to appear
      try {
        await page.waitForFunction(() => {
          const url = window.location.href;
          const errorEl = document.getElementById('tc-error') || document.querySelector('.errorMsg, [class*="error"]');
          const hasError = errorEl && errorEl.innerText.trim().length > 0;
          const verificationForm = document.querySelector('input#tc, input[name="tc"], input[id*="code" i][type="text"], input[autocomplete="one-time-code"]');
          const verificationText = /enter your verification code|verification code was sent/i.test(document.body?.innerText || '');
          const onVerificationPage = /TotpVerification|loginflow|challenge|mfa|otp/i.test(url) || verificationForm || verificationText;
          return hasError || !onVerificationPage;
        }, { timeout: 30_000 });
      } catch (err) {
        console.warn('[verify] waitForFunction timed out, checking state anyway...');
      }

      await page.waitForTimeout(1000); // Give DOM a moment to settle
      const currentUrl = page.url();
      console.log('[verify] Verification response processed.');

      // Check if we are still on the verify page or if an error is visible
      let errorText = null;
      try {
        errorText = await page.evaluate(() => {
          const el = document.getElementById('tc-error') || document.querySelector('.errorMsg');
          return el ? el.innerText.trim() : null;
        });
      } catch (e) {
        // If evaluate throws, it means the page is actively navigating away (success)
        console.log('[verify] Navigation in progress, skipping error text check.');
      }

      const verificationState = await getVerificationState(page).catch(() => ({
        isVerificationPage: true,
        isEmailChallenge: false,
        emailCodePrefix: null,
      }));

      if (verificationState.isEmailChallenge) {
        console.log('[verify] Email verification is required. Waiting for email code.');
        if (session.keepAliveTimer) clearInterval(session.keepAliveTimer);
        session.status = 'waiting_email_verify';
        session.emailVerifyError = null;
        session.emailCodePrefix = verificationState.emailCodePrefix;
        return;
      }

      const stillOnVerificationPage = await page.evaluate(() => {
        const verificationForm = document.querySelector('input#tc, input[name="tc"], input[id*="code" i][type="text"], input[autocomplete="one-time-code"]');
        const verificationText = /enter your verification code|verification code was sent/i.test(document.body?.innerText || '');
        return Boolean(verificationForm || verificationText);
      }).catch(() => true);

      if (errorText || stillOnVerificationPage || /TotpVerification|loginflow|challenge|mfa|otp/i.test(currentUrl)) {
        const msg = errorText || (stillOnVerificationPage
          ? 'Verification was not completed. Check the code and try again.'
          : 'Invalid or expired verification code. Try again.');
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

// ── POST /verify-email ───────────────────────────────────────────────────────
// Handles CFPB's optional email verification step after the first factor.
app.post('/verify-email', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code is required' });
  if (!session.active) return res.status(409).json({ error: 'No active session' });
  if (session.status !== 'waiting_email_verify') {
    return res.status(409).json({ error: `Session is in state "${session.status}", not waiting for email verification` });
  }

  session.status = 'verifying_email';
  session.emailVerifyError = null;
  res.json({ message: 'Email verification code received, processing…' });

  (async () => {
    try {
      const page = session.page;
      const codeInput = page.locator('input#tc:visible, input[name="tc"]:visible, input[id*="code" i][type="text"]:visible, input[autocomplete="one-time-code"]:visible').first();
      await codeInput.waitFor({ state: 'visible', timeout: 30_000 });
      await codeInput.fill(code.trim());
      await page.locator('input[type="submit"]#save:visible, button[type="submit"]:visible').first().click();

        await page
          .waitForFunction(
            () => {
              const url = window.location.href;
              const bodyText = document.body?.innerText || "";
              const verificationForm = document.querySelector(
                'input#tc, input[name="tc"], input[id*="code" i][type="text"], input[autocomplete="one-time-code"]',
              );
              const stillInLoginFlow = /TotpVerification|loginflow|challenge|mfa|otp/i.test(url);
              const verificationText = /enter your verification code|verification code was sent|first\s*3\s*letters/i.test(bodyText);
              return !stillInLoginFlow && !verificationForm && !verificationText;
            },
            { timeout: 30_000 },
          )
          .catch(() => {
            console.warn('[verify-email] Verification response did not leave the login flow within 30 seconds.');
          });
      const verificationState = await getVerificationState(page).catch(() => ({ isVerificationPage: true, isEmailChallenge: true, emailCodePrefix: null }));
      if (verificationState.isVerificationPage) {
        session.status = 'waiting_email_verify';
        session.emailVerifyError = 'Email verification was not completed. Check the code and try again.';
        session.emailCodePrefix = verificationState.emailCodePrefix || session.emailCodePrefix;
        return;
      }

      await handleVerifySuccess(page);
    } catch (err) {
      console.error('[verify-email] Error:', err.message);
      session.status = 'error';
      session.error = err.message;
      session.active = false;
      if (session.keepAliveTimer) clearInterval(session.keepAliveTimer);
    }
  })();
});

// ── Handle successful verification ───────────────────────────────────────────
async function handleVerifySuccess(page) {
  const verificationState = await getVerificationState(page).catch(() => ({
    isVerificationPage: true,
    isEmailChallenge: false,
    emailCodePrefix: null,
  }));
  const stillInLoginFlow = /TotpVerification|loginflow|challenge|mfa|otp/i.test(page.url());

  // This is the last boundary before scraping. Never scrape a CFPB 2FA page,
  // even if an earlier navigation check classified it as successful.
  if (verificationState.isEmailChallenge) {
    console.log('[verify] Email verification is required. Waiting for email code.');
    session.status = 'waiting_email_verify';
    session.emailVerifyError = null;
    session.emailCodePrefix = verificationState.emailCodePrefix;
    return;
  }
  if (verificationState.isVerificationPage || stillInLoginFlow) {
    console.log('[verify] CFPB verification is still pending. Waiting for another code.');
    session.status = 'waiting_verify';
    session.verifyError = 'The verification page is still active. Enter the current code and try again.';
    return;
  }

  console.log('[verify] Verification succeeded.');
  if (session.keepAliveTimer) clearInterval(session.keepAliveTimer);
  session.verifyError = null;
  session.status = 'scraping';
  const data = await scrapeDashboard(page);
  clearSession();
  session.dashboardData = data;
  session.status = 'done';
  console.log('[verify] Done. Dashboard data scraped.');
}

// ── Dashboard scraper ─────────────────────────────────────────────────────────
async function scrapeDashboard(page) {
  try {
    await page.waitForLoadState('networkidle', { timeout: 30_000 });
  } catch (_) { /* best effort */ }

  console.log('[scrapeDashboard] Dashboard loaded.');

  // ── Step 1: Navigate to Complaints tab ──────────────────────────────────────
  console.log('[scrapeDashboard] Clicking Complaints tab...');
  try {
    await page.click('a:has-text("Complaints"), a[title="Complaints"]', { timeout: 15_000 });
    await page.waitForLoadState('networkidle', { timeout: 30_000 });
    console.log('[scrapeDashboard] Complaints page loaded.');
    await page.waitForTimeout(3000);
  } catch (err) {
    console.warn('[scrapeDashboard] Could not navigate to Complaints:', err.message);
  }

  // ── Step 1b: Click "Active complaints" section/tab ──────────────────────────
  console.log('[scrapeDashboard] Looking for Active complaints section...');
  try {
    // Try multiple selector strategies for the "Active complaints" link/tab
    const activeLink = page.locator([
      'a:has-text("Active complaints")',
      'a:has-text("Active Complaints")',
      'button:has-text("Active complaints")',
      'button:has-text("Active Complaints")',
      '[role="tab"]:has-text("Active")',
      'a[title*="Active"]',
      'h2:has-text("Active complaints")',
      'h3:has-text("Active complaints")',
    ].join(', ')).first();

    if ((await activeLink.count()) > 0) {
      console.log('[scrapeDashboard] Found "Active complaints" element, clicking...');
      await activeLink.click();
      await page.waitForTimeout(3000);
      try { await page.waitForLoadState('networkidle', { timeout: 15_000 }); } catch (_) {}
      console.log('[scrapeDashboard] Active complaints section loaded.');
    } else {
      console.log('[scrapeDashboard] No explicit "Active complaints" tab found, using current view...');
    }
    // Extra wait for table data to load
    await page.waitForTimeout(2000);
  } catch (err) {
    console.warn('[scrapeDashboard] Could not click Active complaints:', err.message);
  }

  // ── Step 2: Hover & click the top complaint ID link ─────────────────────────
  console.log('[scrapeDashboard] Looking for top complaint link in Active complaints...');
  let complaintDetailData = null;

  try {
    // Salesforce can render this list as a table or as hydrated LWC links.
    // Wait for either shape instead of assuming the table exists immediately.
    await page.waitForFunction(() => {
      return [...document.querySelectorAll('a, [role="link"]')]
        .some((el) => /complaint|detail/i.test(el.getAttribute('href') || '') || /\b\d{5,}\b/.test(el.innerText || ''));
    }, { timeout: 30_000 }).catch(() => {
      console.warn('[scrapeDashboard] Complaint list did not expose links within 30 seconds.');
    });

    // Select a real data row first. Never fall back to arbitrary buttons because
    // the page also contains verification and account-management controls.
    const dataRows = page.locator('table tbody tr, [role="row"]');
    const rowCount = await dataRows.count();
    let link = page.locator('a[href*="complaint-detail"], a[href*="/s/detail"], [role="link"][href*="complaint-detail"], [role="link"][href*="/s/detail"]').first();

    for (let index = 0; index < rowCount && (await link.count()) === 0; index += 1) { 
      const row = dataRows.nth(index);
      const cells = row.locator('td, [role="cell"]');
      const firstCellText = (await cells.first().innerText().catch(() => '')).trim();
      const rowText = (await row.innerText()).trim();
      const complaintIdMatch = firstCellText.match(/\b\d{5,}\b/) || rowText.match(/\b\d{5,}\b/);
      if (complaintIdMatch) {
        const rowLink = row.locator('a, [role="link"]:not([aria-disabled="true"])').first();
        if ((await rowLink.count()) > 0) {
          link = rowLink;
        }
      }
    }

    if ((await link.count()) > 0) {
      const complaintId = (await link.innerText()).trim();
      const listUrl = page.url();
      console.log(`[scrapeDashboard] Complaint candidate href: ${await link.getAttribute('href') || '(button/no href)'}`);
      console.log(`[scrapeDashboard] Found complaint ${complaintId}.`);

      // Hover first to trigger any tooltip/preview
      await link.hover();
      await page.waitForTimeout(800);

      // Click and navigate to the detail page
      console.log(`[scrapeDashboard] Clicking complaint: ${complaintId}`);
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle', timeout: 45_000 }).catch(() => {}),
        link.click().catch(() => {}),
      ]);

      // Extra wait for Salesforce LWC components to fully render
      await page.waitForTimeout(4000);
      try { await page.waitForLoadState('networkidle', { timeout: 15_000 }); } catch (_) {}

      const detailUrl = page.url();
      if (detailUrl === listUrl) {
        throw new Error(`Complaint link did not navigate away from the list page: ${detailUrl}`);
      }
      console.log(`[scrapeDashboard] Complaint detail page loaded: ${detailUrl}`);

      // ── Step 3: Extract all complaint detail data ──────────────────────────
      complaintDetailData = await page.evaluate(() => {
        const clean = (s) => (s || '').trim().replace(/\s+/g, ' ');

        // Helper: get label-value pairs from Salesforce layout
        const extractLabelValue = (scopeSelector) => {
          const result = {};
          const scope = scopeSelector ? document.querySelector(scopeSelector) : document;
          if (!scope) return result;
          scope.querySelectorAll(
            '.slds-form-element, .forcePageBlockItem, [class*="formElement"], [class*="field"]'
          ).forEach((el) => {
            const labelEl = el.querySelector(
              '.slds-form-element__label, label, .fieldLabel, .test-id__field-label, dt'
            );
            const valueEl = el.querySelector(
              '.slds-form-element__control, .fieldValue, .test-id__field-value, dd, ' +
              'lightning-formatted-text, span[class*="value"], p, .outputLookupLink'
            );
            if (labelEl && valueEl) {
              const lbl = clean(labelEl.innerText);
              const val = clean(valueEl.innerText);
              if (lbl && val) result[lbl] = val;
            }
          });
          return result;
        };

        // Complaint ID from URL hash or heading
        const idFromHash = window.location.hash.replace('#', '');
        const headingEl = document.querySelector('h1, h2, [class*="title"]');
        const complaintId = clean(headingEl?.innerText) || idFromHash;

        // Status sidebar
        const statusEl = document.querySelector('.COMPLAINT_STATUS, [class*="complaintStatus"], [class*="status"]');
        const complaintStatus = clean(statusEl?.innerText) || '';

        // Primary consumer info
        const consumerSection = (() => {
          const allText = [...document.querySelectorAll('h2, h3')]
            .find(h => /primary consumer/i.test(h.innerText));
          return allText?.closest('section, div.slds-card, div.forcePageBlockSection') || null;
        })();

        const getSection = (regex) => {
          const heading = [...document.querySelectorAll('h2, h3, h4, .slds-text-heading, .sectionHeader')]
            .find(h => regex.test(h.innerText));
          return heading?.closest('section, div.slds-card, div.forcePageBlockSection, div') || null;
        };

        // Generic field extraction across the whole page
        const allFields = {};
        document.querySelectorAll(
          '.slds-form-element, .forcePageBlockItem, dl dt, [data-field-name]'
        ).forEach((el) => {
          const isLabel = el.tagName === 'DT' || el.matches('.slds-form-element, .forcePageBlockItem');
          let lbl = '', val = '';
          if (el.tagName === 'DT') {
            lbl = clean(el.innerText);
            val = clean(el.nextElementSibling?.innerText || '');
          } else {
            const labelEl = el.querySelector(
              '.slds-form-element__label, label, .fieldLabel, dt, .test-id__field-label'
            );
            const valueEl = el.querySelector(
              '.slds-form-element__control, .fieldValue, dd, lightning-formatted-text, ' +
              '.outputLookupLink, .test-id__field-value, span, p'
            );
            lbl = clean(labelEl?.innerText || '');
            val = clean(valueEl?.innerText || '');
          }
          if (lbl && val && lbl !== val) allFields[lbl] = val;
        });

        // Attachments
        const attachments = [...document.querySelectorAll(
          'a[href*="download"], a[href*="shepherd"], .slds-file-selector, [class*="attachment"] a, [class*="file"] a'
        )].map(a => ({
          name: clean(a.innerText) || clean(a.getAttribute('title') || ''),
          href: a.href,
        })).filter(a => a.name);

        // "What happened" narrative
        const narrativeEl = document.querySelector(
          '[class*="narrative"], [class*="description"], .slds-rich-text-area'
        );
        const narrative = clean(narrativeEl?.innerText || '');

        // Extract all visible text sections by heading
        const sections = {};
        document.querySelectorAll('h2, h3').forEach(heading => {
          const title = clean(heading.innerText);
          if (!title) return;
          let next = heading.nextElementSibling;
          let content = '';
          while (next && !['H1','H2','H3'].includes(next.tagName)) {
            content += ' ' + clean(next.innerText);
            next = next.nextElementSibling;
          }
          if (content.trim()) sections[title] = content.trim();
        });

        // Complaint status sidebar
        const sidebarItems = {};
        document.querySelectorAll('[class*="sidebar"] dt, [class*="sidebar"] dd').forEach((el, idx, arr) => {
          if (el.tagName === 'DT') {
            const lbl = clean(el.innerText);
            const val = clean(arr[idx + 1]?.innerText || '');
            if (lbl) sidebarItems[lbl] = val;
          }
        });

        // Response options (radio buttons)
        const responseOptions = [...document.querySelectorAll('input[type="radio"]')]
          .map(r => clean(r.closest('label, [role="radio"]')?.innerText || r.value))
          .filter(Boolean);

        return {
          complaintId,
          detailUrl: window.location.href,
          complaintStatus,
          allFields,
          sections,
          sidebarItems,
          attachments,
          narrative,
          responseOptions,
          pageTitle: document.title,
        };
      });

      console.log('[scrapeDashboard] Extracted detail data for:', complaintDetailData.complaintId);
    } else {
      console.warn(`[scrapeDashboard] No actionable complaint link found. rows=${rowCount}`);
    }
  } catch (err) {
    console.error('[scrapeDashboard] Error navigating to complaint detail:', err.message);
  }

  const result = {
    url: page.url(),
    scrapedAt: new Date().toISOString(),
    complaintDetail: complaintDetailData,
  };

  const hasComplaintDetails = complaintDetailData && (
    complaintDetailData.complaintId ||
    Object.keys(complaintDetailData.allFields || {}).length > 0 ||
    Object.keys(complaintDetailData.sections || {}).length > 0 ||
    Object.keys(complaintDetailData.sidebarItems || {}).length > 0 ||
    complaintDetailData.narrative ||
    complaintDetailData.attachments?.length > 0
  );

  if (!hasComplaintDetails) {
    const diagnostics = await page.evaluate(() => ({
      title: document.title,
      url: window.location.href,
      anchors: document.querySelectorAll('a, [role="link"]').length,
      tables: document.querySelectorAll('table, [role="table"]').length,
      rows: document.querySelectorAll('table tbody tr, [role="row"]').length,
      bodyText: (document.body?.innerText || '').trim().slice(0, 300),
    })).catch(() => ({ title: '', url: page.url(), anchors: -1, tables: -1, rows: -1, bodyText: '' }));
    throw new Error(`Complaint details were not extracted; webhook delivery was skipped. Page: ${diagnostics.title} (${diagnostics.url}); anchors=${diagnostics.anchors}, tables=${diagnostics.tables}, rows=${diagnostics.rows}; body="${diagnostics.bodyText}"`);
  }

  console.log('[scrapeDashboard] Sending data to webhook...');
  const n8nResult = await sendToN8n(result);
  if (!n8nResult.ok) {
    throw new Error(n8nResult.error || `Webhook request failed with status ${n8nResult.status}`);
  }
  console.log('[scrapeDashboard] Webhook accepted the complaint data.');
  
  let webhookResponse = null;
  if (n8nResult.ok && n8nResult.responseText) {
    try {
      let parsed = JSON.parse(n8nResult.responseText);
      if (Array.isArray(parsed) && parsed.length > 0) {
        parsed = parsed[0]; // Extract first object if array
      }
      webhookResponse = parsed;
      console.log('[scrapeDashboard] Parsed webhook response as JSON.');
    } catch(e) {
      console.warn('[scrapeDashboard] Webhook response is not standard JSON. Attempting extraction...');
      // Fallback: Try to find a JSON object or array within the text response
      const jsonMatch = n8nResult.responseText.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
      let extracted = false;
      if (jsonMatch) {
        try {
          let parsed = JSON.parse(jsonMatch[0]);
          if (Array.isArray(parsed) && parsed.length > 0) {
            parsed = parsed[0];
          }
          webhookResponse = parsed;
          extracted = true;
          console.log('[scrapeDashboard] Extracted webhook response from text.');
        } catch(fallbackErr) {}
      }
      
      // If it's pure raw text (like the logs show), wrap it so the rest of the code works
      if (!extracted) {
        console.log('[scrapeDashboard] Webhook returned raw text. Wrapping it automatically.');
        webhookResponse = { complaint_response: n8nResult.responseText.trim() };
      }
    }
  }
  
  if (webhookResponse && webhookResponse.complaint_response) {
    try {
      console.log('\n[scrapeDashboard] --- Automating Original Portal Response ---');
      
      const optionLabel = page.locator('label:has-text("Closed with explanation"), [role="radio"]:has-text("Closed with explanation"), span:has-text("Closed with explanation")').first();
      
      if ((await optionLabel.count()) > 0) {
        await optionLabel.click();
        console.log('[scrapeDashboard] ✔ Clicked option: "Closed with explanation"');
        
        await page.waitForTimeout(1500); // Wait for textarea to appear
        
        const textarea = page.locator('textarea').first();
        if ((await textarea.count()) > 0) {
          await textarea.fill(webhookResponse.complaint_response);
          console.log('[scrapeDashboard] ✔ Added the webhook response to the portal form.');
          console.log('[scrapeDashboard] Note: Response was NOT submitted per instructions.');
        } else {
          console.warn('[scrapeDashboard] ⚠ Textarea not found after clicking the option.');
        }
      } else {
         console.warn('[scrapeDashboard] ⚠ Could not find the "Closed with explanation" option on the page.');
      }
      console.log('[scrapeDashboard] ---------------------------------------------\n');
    } catch (e) {
      console.error('[scrapeDashboard] Failed to interact with original portal:', e.message);
    }
  }

  result.webhookResponse = webhookResponse;

  return result;
}

// ── GET /status ───────────────────────────────────────────────────────────────
app.get('/status', (req, res) => {
  const secondsLeft = session.keepAliveExpiry
    ? Math.max(0, Math.round((session.keepAliveExpiry - Date.now()) / 1000))
    : null;

  res.json({
    appVersion: APP_VERSION,
    active: session.active,
    status: session.status,
    error: session.error,
    verifyError: session.verifyError,
    emailVerifyError: session.emailVerifyError,
    emailCodePrefix: session.emailCodePrefix,
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
app.listen(PORT, () => console.log(`[server] CFPB backend listening on port ${PORT}.`));
