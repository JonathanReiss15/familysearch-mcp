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

const BRAVE_PATHS = {
  darwin: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
  linux: ['/usr/bin/brave-browser', '/usr/bin/brave', '/snap/bin/brave'],
  win32: [
    join(process.env.PROGRAMFILES || 'C:\\Program Files', 'BraveSoftware/Brave-Browser/Application/brave.exe'),
    join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'BraveSoftware/Brave-Browser/Application/brave.exe'),
  ],
};

function findBraveExecutable() {
  if (process.env.BRAVE_PATH && existsSync(process.env.BRAVE_PATH)) {
    return process.env.BRAVE_PATH;
  }

  const candidates = BRAVE_PATHS[platform()] || [];
  return candidates.find((path) => existsSync(path)) || null;
}

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

// True once the page shows a signed-in user. FamilySearch has stored the user under
// several localStorage keys over time: the older '<prefix>-v3-user' object, and newer
// keys that contain the CIS id ('cis.user.XXXX-XXXX', 'segment/users/cis.user.XXXX-XXXX-...').
function isLoggedInScript() {
  const keys = Object.keys(localStorage);
  const legacyKey = keys.find((key) => key.endsWith('-v3-user'));
  if (legacyKey) {
    try {
      if (JSON.parse(localStorage.getItem(legacyKey) || '{}').user?.cisId) {
        return true;
      }
    } catch {
      // ignore malformed entry and fall through to the newer keys
    }
  }
  return keys.some((key) => /(^|\/)cis\.user\.[A-Z0-9]{4}-[A-Z0-9]{3,4}/.test(key));
}

function readLoggedInUser(page) {
  return page.evaluate(async () => {
    const keys = Object.keys(localStorage);
    const legacyKey = keys.find((key) => key.endsWith('-v3-user'));
    if (legacyKey) {
      try {
        const user = JSON.parse(localStorage.getItem(legacyKey) || '{}').user;
        if (user?.cisId) {
          return {
            displayName: user.displayName || user.contactName || 'FamilySearch user',
            personId: user.personId || '',
          };
        }
      } catch {
        // fall through to the platform API
      }
    }

    // Newer site versions no longer keep displayName/personId in localStorage; ask the
    // platform API for the current user (same-origin request, uses the session cookie).
    try {
      const response = await fetch('/platform/users/current', {
        headers: { Accept: 'application/json' },
        credentials: 'include',
      });
      if (response.ok) {
        const user = (await response.json()).users?.[0];
        if (user) {
          return {
            displayName: user.displayName || user.contactName || 'FamilySearch user',
            personId: user.personId || '',
          };
        }
      }
    } catch {
      // fall through
    }

    const cisKey = keys.find((key) => /(^|\/)cis\.user\./.test(key));
    return cisKey ? { displayName: 'FamilySearch user', personId: '' } : null;
  });
}

async function main() {
  const bravePath = findBraveExecutable();
  if (!bravePath) {
    console.error('Brave browser not found.');
    console.error('Install Brave from https://brave.com/download/ or set BRAVE_PATH to your Brave executable.');
    process.exit(1);
  }

  if (!existsSync(braveProfileDir)) {
    mkdirSync(braveProfileDir, { recursive: true });
  }

  console.error(`Opening Brave for FamilySearch login (${bravePath})...`);
  console.error('Sign in at familysearch.org. This window waits until you are fully logged in (up to 5 minutes).');

  const context = await chromium.launchPersistentContext(braveProfileDir, {
    executablePath: bravePath,
    headless: false,
    viewport: null,
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const page = context.pages()[0] || (await context.newPage());
  await page.goto('https://www.familysearch.org/en/');

  try {
    await page.waitForFunction(isLoggedInScript, undefined, { timeout: 5 * 60 * 1000 });
  } catch {
    console.error('Timed out waiting for login.');
    await context.close();
    process.exit(1);
  }

  const user = await readLoggedInUser(page);
  const cookies = await context.cookies(['https://www.familysearch.org']);
  const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  const sessionCookie = cookies.find((cookie) => cookie.name === 'fssessionid');
  const anidCookie = cookies.find((cookie) => cookie.name === 'fs_anid');

  if (!sessionCookie?.value || !user) {
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
