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
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

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

function readLoggedInUser(page) {
  // FamilySearch versions the key (…-v3-user, …-v4-user), so match any version.
  return page.evaluate(() => {
    const userKey = Object.keys(localStorage).find((key) => /-v\d+-user$/.test(key));
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

  // The sign-in page (ident.familysearch.org) can store the user before the
  // redirect back to www sets fssessionid, so wait for both the cookie and a
  // www page that knows the user.
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let user = null;
  while (!user && Date.now() < deadline) {
    const sessionCookies = await context.cookies(['https://www.familysearch.org']);
    if (sessionCookies.some((cookie) => cookie.name === 'fssessionid')) {
      for (const candidate of context.pages()) {
        if (hostnameOf(candidate.url()) !== 'www.familysearch.org') continue;
        user = await readLoggedInUser(candidate).catch(() => null);
        if (user) break;
      }
    }
    if (!user) await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  if (!user) {
    console.error('Timed out waiting for login.');
    await context.close();
    process.exit(1);
  }

  const cookies = await context.cookies(['https://www.familysearch.org']);
  const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  const sessionCookie = cookies.find((cookie) => cookie.name === 'fssessionid');
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
