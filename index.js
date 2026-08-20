require('dotenv').config();
const express = require('express');
const { chromium } = require('playwright');

const CFPB_EMAIL = process.env.CFPB_EMAIL;
const CFPB_PASSWORD = process.env.CFPB_PASSWORD;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;

if (!CFPB_EMAIL || !CFPB_PASSWORD || !N8N_WEBHOOK_URL) {
  throw new Error('CFPB_EMAIL, CFPB_PASSWORD, and N8N_WEBHOOK_URL must be configured');
}

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
  status: 'idle',         // idle | launching | waiting_verify | verifying | waiting_email_verify | verifying_email | scraping | done | error
  browser: null,
  page: null,
  keepAliveTimer: null,
  keepAliveExpiry: null,
  error: null,
  verifyError: null,      // inline error from the TOTP verify page (bad code)
  emailVerifyError: null, // inline error from the email verify page (bad code)
  emailCodePrefix: null,  // e.g. "JFH-" — pre-filled prefix shown on the email code screen
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
    error: null,
    verifyError: null,
    emailVerifyError: null,
    emailCodePrefix: null,
  };
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
  const webhookUrl = process.env.N8N_WEBHOOK_URL || 'https://usman2737.app.n8n.cloud/webhook-test/3bdb290e-f4e3-44a5-8204-e75501c8d5d0';

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const responseText = await response.text();
    console.log(`[n8n] Webhook status: ${response.status}`);
    if (responseText) {
      console.log(`[n8n] Webhook response: ${responseText}`);
    }

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
        await scrapeDashboard(session.page);
        clearSession();
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

      await page.click('input[type="submit"]#save');

      // Safely wait for either navigation away from the verify page OR an error message to appear
      try {
        await page.waitForFunction(() => {
          const url = window.location.href;
          const errorEl = document.getElementById('tc-error') || document.querySelector('.errorMsg, [class*="error"]');
          const hasError = errorEl && errorEl.innerText.trim().length > 0;
          const leftVerifyPage = !url.includes('TotpVerification') && !url.includes('challenge') && !url.includes('mfa') && !url.includes('otp');
          return hasError || leftVerifyPage;
        }, { timeout: 30_000 });
      } catch (err) {
        console.warn('[verify] waitForFunction timed out, checking state anyway...');
      }

      await page.waitForTimeout(1000); // Give DOM a moment to settle
      const currentUrl = page.url();
      console.log('[verify] After submit URL:', currentUrl);

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

      if (errorText || currentUrl.includes('TotpVerification') || currentUrl.includes('challenge') || currentUrl.includes('mfa')) {
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

// ── Handle successful TOTP verification ──────────────────────────────────────
// After TOTP passes, the portal may show a second email-code screen on the
// first login of the day.  Detect it and pause for user input if needed.
async function handleVerifySuccess(page) {
  console.log('[verify] TOTP accepted! Landed on:', page.url());
  if (session.keepAliveTimer) clearInterval(session.keepAliveTimer);
  session.verifyError = null;

  // Give the page a moment to settle after the TOTP redirect
  await page.waitForTimeout(3000);

  // Check if we landed on the email verification screen (loginFlow)
  const isEmailScreen = await detectEmailVerificationScreen(page);

  if (isEmailScreen) {
    console.log('[verify] Email verification screen detected — pausing for email code.');

    // Read the pre-filled prefix from the input (e.g. "JFH-")
    let prefix = '';
    try {
      const inputEl = await page.$('#thePage\\:j_id2\\:i\\:f\\:pb\\:d\\:CodeInput\\.input');
      if (inputEl) {
        prefix = await inputEl.inputValue();
      } else {
        prefix = await page.inputValue('[name="thePage:j_id2:i:f:pb:d:element___input____CodeInput"]').catch(() => '');
      }
    } catch { /* ignore */ }

    session.emailCodePrefix = prefix || null;
    session.status = 'waiting_email_verify';
    session.active = true; // keep session alive
    startKeepAlive(page);  // restart the keep-alive timer for the new wait window
    return;
  }

  // No email screen — proceed directly to scraping
  await proceedToScrape(page);
}

// ── Proceed to scrape (shared by both verify paths) ──────────────────────────
async function proceedToScrape(page) {
  session.status = 'scraping';
  await scrapeDashboard(page);
  clearSession();
  console.log('[scrape] Done. Data sent to webhook and session reset.');
}

// ── Detect the email verification screen ─────────────────────────────────────
async function detectEmailVerificationScreen(page) {
  try {
    // Primary: the specific input field ID from the CFPB loginFlow page
    const inputEl = await page.$('#thePage\\:j_id2\\:i\\:f\\:pb\\:d\\:CodeInput\\.input');
    if (inputEl) return true;
    // Fallback: body text contains both marker phrases
    const bodyText = await page.textContent('body').catch(() => '');
    if (bodyText.includes('Enter your verification code') && bodyText.includes('emailed to you')) return true;
    return false;
  } catch {
    return false;
  }
}

// ── Dashboard scraper ─────────────────────────────────────────────────────────
async function scrapeDashboard(page) {
  try {
    await page.waitForLoadState('networkidle', { timeout: 30_000 });
  } catch (_) { /* best effort */ }

  console.log('[scrapeDashboard] Landed on dashboard:', page.url());

  // ── Step 1: Navigate to Complaints tab ──────────────────────────────────────
  console.log('[scrapeDashboard] Clicking Complaints tab...');
  try {
    await page.click('a:has-text("Complaints"), a[title="Complaints"]', { timeout: 15_000 });
    await page.waitForLoadState('networkidle', { timeout: 30_000 });
    console.log('[scrapeDashboard] On Complaints page:', page.url());
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
      console.log('[scrapeDashboard] Active complaints section loaded:', page.url());
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
    // Find the first complaint link in the table
    const topLink = await page.locator(
      'table tbody tr:first-child td a[href*="complaint-detail"], table tbody tr:first-child td a[href*="/s/detail"]'
    ).first();

    // Fallback: any anchor in first data row of any table
    let link = topLink;
    if ((await link.count()) === 0) {
      link = page.locator('table tr:nth-child(2) td a, table tbody tr:first-child td a').first();
    }

    if ((await link.count()) > 0) {
      const complaintId = (await link.innerText()).trim();
      const detailHref = await link.getAttribute('href');
      console.log(`[scrapeDashboard] Hovering over top complaint: ${complaintId} -> ${detailHref}`);

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
      console.log('[scrapeDashboard] Detail page URL:', detailUrl);

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
      console.warn('[scrapeDashboard] No complaint links found in the table.');
    }
  } catch (err) {
    console.error('[scrapeDashboard] Error navigating to complaint detail:', err.message);
  }

  const result = {
    url: page.url(),
    scrapedAt: new Date().toISOString(),
    complaintDetail: complaintDetailData,
  };

  console.log('[scrapeDashboard] Sending data to webhook...');
  sendToN8n(result);

  return result;
}

// ── POST /verify-email ────────────────────────────────────────────────────────
// Receives the full email verification code (e.g. "JFH-123456") and enters it
// into the active Playwright session that is paused on the loginFlow page.
app.post('/verify-email', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code is required' });
  if (!session.active) return res.status(409).json({ error: 'No active session' });
  if (session.status !== 'waiting_email_verify') {
    return res.status(409).json({ error: `Session is in state "${session.status}", not waiting for email code` });
  }

  session.status = 'verifying_email';
  session.emailVerifyError = null;
  res.json({ message: 'Email verification code received, processing…' });

  (async () => {
    try {
      const page = session.page;
      console.log('[verify-email] Entering email code…');

      // Fill the code input — clear the pre-filled prefix first
      let filled = false;
      try {
        const inputEl = await page.$('#thePage\\:j_id2\\:i\\:f\\:pb\\:d\\:CodeInput\\.input');
        if (inputEl) {
          await inputEl.click({ clickCount: 3 }); // select all
          await inputEl.fill(code.trim());
          filled = true;
        }
      } catch { /* try fallback */ }

      if (!filled) {
        await page.click('[name="thePage:j_id2:i:f:pb:d:element___input____CodeInput"]', { clickCount: 3 });
        await page.fill('[name="thePage:j_id2:i:f:pb:d:element___input____CodeInput"]', code.trim());
      }

      // Click the Next button
      console.log('[verify-email] Clicking Next…');
      try {
        await page.click('#thePage\\:j_id2\\:i\\:f\\:pb\\:pbb\\:nextAjax');
      } catch {
        await page.click('input[value="Next"], button:has-text("Next")');
      }

      // Wait for either: navigation away from loginFlow (success) OR an error appearing
      try {
        await page.waitForFunction(() => {
          const url = window.location.href;
          const leftFlow = !url.includes('loginFlow');
          // Look for any visible error message on the page
          const errEl = document.querySelector('[class*="error"], .errorMsg, .pbError');
          const hasError = errEl && errEl.innerText.trim().length > 0;
          return leftFlow || hasError;
        }, { timeout: 30_000 });
      } catch {
        console.warn('[verify-email] waitForFunction timed out, checking state…');
      }

      await page.waitForTimeout(1500);
      const currentUrl = page.url();
      console.log('[verify-email] Post-submit URL:', currentUrl);

      // Check for an inline error (wrong code)
      let errorText = null;
      try {
        errorText = await page.evaluate(() => {
          const el = document.querySelector('[class*="error"], .errorMsg, .pbError');
          return el ? el.innerText.trim() : null;
        });
      } catch { /* navigation in progress = success */ }

      if (errorText || currentUrl.includes('loginFlow')) {
        const msg = errorText || 'Invalid or expired email verification code. Try again.';
        console.log('[verify-email] Bad code:', msg);
        session.status = 'waiting_email_verify'; // allow retry
        session.emailVerifyError = msg;
      } else {
        // Success — proceed to scraping
        console.log('[verify-email] Email verification accepted!');
        if (session.keepAliveTimer) clearInterval(session.keepAliveTimer);
        session.emailVerifyError = null;
        session.emailCodePrefix = null;
        await proceedToScrape(page);
      }
    } catch (err) {
      console.error('[verify-email] Error:', err.message);
      session.status = 'error';
      session.error = err.message;
      session.active = false;
      if (session.keepAliveTimer) clearInterval(session.keepAliveTimer);
    }
  })();
});

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
    emailVerifyError: session.emailVerifyError,
    emailCodePrefix: session.emailCodePrefix,
    keepAliveSecondsLeft: secondsLeft,
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
