#!/usr/bin/env node
/**
 * Opens Brave for FamilySearch login and saves the session cookie locally.
 * Uses the installed Brave browser instead of Playwright Chromium to avoid bot detection.
 *
 * Usage: npm run login
 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir, platform } from 'os';
import { join } from 'path';

const configDir = join(homedir(), '.familysearch-mcp');
const configPath = join(configDir, 'config.json');
const braveProfileDir = join(configDir, 'brave-profile');

// Real, installed Chromium-based browsers. Playwright's bundled Chromium is
// blocked by FamilySearch bot detection, so we drive one of these instead.
// Brave is preferred; Chrome and Edge also work. (Arc and Dia are Chromium-based
// but don't accept the remote-control flags Playwright needs, so they're omitted.)
const BROWSER_PATHS = {
  darwin: [
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  linux: [
    '/usr/bin/brave-browser',
    '/usr/bin/brave',
    '/snap/bin/brave',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ],
  win32: [
    join(process.env.PROGRAMFILES || 'C:\\Program Files', 'BraveSoftware/Brave-Browser/Application/brave.exe'),
    join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'BraveSoftware/Brave-Browser/Application/brave.exe'),
    join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
    join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
    join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft/Edge/Application/msedge.exe'),
    join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
  ],
};

function findBrowserExecutable() {
  // BROWSER_PATH takes precedence; BRAVE_PATH stays supported for compatibility.
  const override = process.env.BROWSER_PATH || process.env.BRAVE_PATH;
  if (override && existsSync(override)) {
    return override;
  }

  const candidates = BROWSER_PATHS[platform()] || [];
  return candidates.find((path) => existsSync(path)) || null;
}

// How long to wait for sign-in before giving up. Default 5 minutes.
const loginTimeoutMinutes = Number(process.env.LOGIN_TIMEOUT_MINUTES) || 5;

function loadConfig() {
  if (!existsSync(configPath)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(config) {
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}

// FamilySearch issues an fssessionid cookie to anonymous visitors too, so the
// cookie alone doesn't prove sign-in. Call an endpoint that 401s for anonymous
// sessions from inside the page (so bot-protection cookies and TLS match).
// Returns the user's tree person ID ('' if they have none) or null if not signed in.
async function checkSignedIn(page) {
  if (!page.url().startsWith('https://www.familysearch.org/')) {
    return null;
  }
  try {
    return await page.evaluate(async () => {
      const response = await fetch('/service/tree/tree-data/user/CURRENT/starting-person-id', {
        headers: { Accept: 'application/json' },
        credentials: 'include',
      });
      if (!response.ok) {
        return null;
      }
      const text = (await response.text()).trim();
      try {
        const data = JSON.parse(text);
        return typeof data === 'string' ? data : data?.personId || data?.id || '';
      } catch {
        return text;
      }
    });
  } catch {
    // The page navigated mid-evaluate (e.g. redirecting through sign-in); try again next poll.
    return null;
  }
}

async function readLoggedInUser(page) {
  try {
    return await readLoggedInUserUnsafe(page);
  } catch {
    return null;
  }
}

function readLoggedInUserUnsafe(page) {
  return page.evaluate(() => {
    const userKey = Object.keys(localStorage).find((key) => key.endsWith('-v3-user'));
    if (!userKey) {
      return null;
    }

    try {
      const data = JSON.parse(localStorage.getItem(userKey) || '{}');
      const user = data.user;
      if (!user?.cisId) {
        return null;
      }

      return {
        displayName: user.displayName || user.contactName || 'FamilySearch user',
        personId: user.personId || '',
      };
    } catch {
      return null;
    }
  });
}

async function main() {
  const browserPath = findBrowserExecutable();
  if (!browserPath) {
    console.error('No supported browser (Brave, Chrome, or Edge) found.');
    console.error('Install one, or set BROWSER_PATH to a Chromium-based browser executable.');
    process.exit(1);
  }

  if (!existsSync(braveProfileDir)) {
    mkdirSync(braveProfileDir, { recursive: true });
  }

  console.error(`Opening browser for FamilySearch login (${browserPath})...`);
  console.error(
    `Sign in at familysearch.org. This window waits until you are fully logged in (up to ${loginTimeoutMinutes} minute${loginTimeoutMinutes === 1 ? '' : 's'}).`,
  );

  const context = await chromium.launchPersistentContext(braveProfileDir, {
    executablePath: browserPath,
    headless: false,
    viewport: null,
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const page = context.pages()[0] || (await context.newPage());
  await page.goto('https://www.familysearch.org/en/');

  // Poll until an authenticated request succeeds. Check every open tab, since
  // sign-in may finish in a different one than we opened.
  const deadline = Date.now() + loginTimeoutMinutes * 60 * 1000;
  let signedInPage;
  let startingPersonId = null;
  while (Date.now() < deadline && !signedInPage) {
    for (const candidate of context.pages()) {
      startingPersonId = await checkSignedIn(candidate);
      if (startingPersonId !== null) {
        signedInPage = candidate;
        break;
      }
    }
    if (!signedInPage) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  if (!signedInPage) {
    console.error('Timed out waiting for login.');
    await context.close();
    process.exit(1);
  }

  // Give the page a moment to finish writing its other session cookies.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const storedUser = await readLoggedInUser(signedInPage);
  const user = {
    displayName: storedUser?.displayName || 'FamilySearch user',
    personId: storedUser?.personId || startingPersonId || '',
  };
  let sessionCookie;
  const cookies = await context.cookies(['https://www.familysearch.org']);
  const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  sessionCookie = cookies.find((cookie) => cookie.name === 'fssessionid') || sessionCookie;
  const anidCookie = cookies.find((cookie) => cookie.name === 'fs_anid');

  if (!sessionCookie?.value) {
    console.error('Login was not detected. Make sure you signed in with your FamilySearch account.');
    await context.close();
    process.exit(1);
  }

  const existing = loadConfig();

  const config = {
    cookies: cookieHeader,
    sessionId: sessionCookie.value,
    fsAnid: anidCookie?.value || existing.fsAnid || '',
    userDisplayName: user.displayName,
    userPersonId: user.personId,
  };

  saveConfig(config);
  console.error(`Signed in as ${user.displayName}${user.personId ? ` (${user.personId})` : ''}.`);
  console.error(`Session saved to ${configPath}`);

  await context.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
