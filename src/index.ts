import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { loadConfig, saveConfig, type FamilySearchConfig } from './config.js';
import {
  describeImage,
  describeRights,
  formatBytes,
  imageFileName,
  isSavedJpeg,
  jpegSize,
  resolveDownloadDir,
  saveJpeg,
} from './images.js';
import {
  FamilySearchSessionClient,
  FamilySearchSessionError,
  formatCardBirthDeath,
  type ResolvedImage,
} from './session-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const loginScriptPath = join(__dirname, '..', 'scripts', 'browser-login.mjs');

let config: FamilySearchConfig = loadConfig();
const sessionClient = new FamilySearchSessionClient({
  sessionId: config.sessionId,
  fsAnid: config.fsAnid,
  cookies: config.cookies,
});

const persistConfig = () => saveConfig(config);

const server = new McpServer({
  name: 'familysearch',
  version: '2.0.0',
});

function isAuthenticated(): boolean {
  return sessionClient.isAuthenticated();
}

function authRequiredText(): string {
  return 'Not authenticated. Run login-with-browser or set-session-cookie first.';
}

function formatError(error: unknown): string {
  if (error instanceof FamilySearchSessionError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return JSON.stringify(error);
}

function extractCookieValue(cookieHeader: string, name: string): string {
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match?.[1] || '';
}

function applySessionCookies(cookies: string, sessionId?: string, fsAnid?: string): void {
  config.cookies = cookies.trim();
  config.sessionId = sessionId?.trim() || extractCookieValue(config.cookies, 'fssessionid');
  config.fsAnid = fsAnid?.trim() || extractCookieValue(config.cookies, 'fs_anid');
  sessionClient.setSession(config.sessionId, config.fsAnid, config.cookies);
}

server.tool(
  'set-session-cookie',
  'Authenticate using browser cookies copied from familysearch.org (DevTools console: copy(document.cookie))',
  {
    cookies: z
      .string()
      .optional()
      .describe('Full cookie string from document.cookie (recommended)'),
    sessionId: z
      .string()
      .optional()
      .describe('The fssessionid cookie alone (may be blocked without bot-protection cookies)'),
    fsAnid: z.string().optional().describe('Optional fs_anid cookie value'),
  },
  async ({ cookies, sessionId, fsAnid }: { cookies?: string; sessionId?: string; fsAnid?: string }) => {
    if (!cookies && !sessionId) {
      return {
        content: [{ type: 'text', text: 'Provide either cookies (full string, recommended) or sessionId.' }],
      };
    }

    applySessionCookies(cookies || '', sessionId, fsAnid);

    try {
      const user = await sessionClient.validateSession({
        displayName: config.userDisplayName,
        personId: config.userPersonId,
      });
      config.userDisplayName = user.displayName;
      config.userPersonId = user.personId;
      persistConfig();

      return {
        content: [
          {
            type: 'text',
            text: `Browser session saved. Authenticated as ${user.displayName}${user.personId ? ` (${user.personId})` : ''}.`,
          },
        ],
      };
    } catch (error) {
      config.cookies = '';
      config.sessionId = '';
      persistConfig();
      return {
        content: [{ type: 'text', text: `Session validation failed: ${formatError(error)}` }],
      };
    }
  },
);

server.tool(
  'login-with-browser',
  'Open a browser window to log in to FamilySearch and save the session cookie locally',
  {},
  async () => {
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [loginScriptPath], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stderr = '';
        child.stderr.on('data', (chunk) => {
          stderr += chunk.toString();
        });

        child.on('error', reject);
        child.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(stderr || `Browser login exited with code ${code}`));
        });
      });
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Browser login failed: ${formatError(error)}` }],
      };
    }

    config = loadConfig();
    sessionClient.setSession(config.sessionId, config.fsAnid, config.cookies);

    if (!isAuthenticated()) {
      return {
        content: [{ type: 'text', text: 'Browser login did not save a session cookie.' }],
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: 'Browser login complete. Session saved to ~/.familysearch-mcp/config.json.',
        },
      ],
    };
  },
);

server.tool('get-current-user', 'Get information about the currently authenticated user', {}, async () => {
  if (!isAuthenticated()) {
    return { content: [{ type: 'text', text: authRequiredText() }] };
  }

  try {
    const user = await sessionClient.validateSession({
      displayName: config.userDisplayName,
      personId: config.userPersonId,
    });
    config.userDisplayName = user.displayName;
    config.userPersonId = user.personId;
    persistConfig();

    return {
      content: [
        {
          type: 'text',
          text: `Current user: ${user.displayName}\nPerson ID: ${user.personId || 'Unknown'}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error fetching user info: ${formatError(error)}` }],
    };
  }
});

server.tool(
  'search-persons',
  'Search for person records in FamilySearch',
  {
    name: z.string().optional().describe('Name to search for'),
    birthDate: z.string().optional().describe('Birth date (YYYY-MM-DD)'),
    birthPlace: z.string().optional().describe('Birth place'),
    deathDate: z.string().optional().describe('Death date (YYYY-MM-DD)'),
    deathPlace: z.string().optional().describe('Death place'),
    gender: z.enum(['MALE', 'FEMALE']).optional().describe('Gender'),
    limit: z.number().optional().describe('Maximum number of results (default: 10)'),
  },
  async (params) => {
    if (!isAuthenticated()) {
      return { content: [{ type: 'text', text: authRequiredText() }] };
    }

    try {
      const persons = await sessionClient.searchPersons(params);
      if (!persons.length) {
        return { content: [{ type: 'text', text: 'No persons found matching your search criteria.' }] };
      }

      const resultsText = persons
        .map(
          (person, index) =>
            `${index + 1}. ${person.name} (${person.id})\n   Gender: ${person.gender}\n   Birth: ${person.birth}\n   Death: ${person.death}`,
        )
        .join('\n\n');

      return {
        content: [{ type: 'text', text: `Found ${persons.length} matching records:\n\n${resultsText}` }],
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error searching persons: ${formatError(error)}` }] };
    }
  },
);

server.tool(
  'get-person',
  'Get detailed information about a specific person',
  {
    personId: z.string().describe('Person ID'),
  },
  async ({ personId }: { personId: string }) => {
    if (!isAuthenticated()) {
      return { content: [{ type: 'text', text: authRequiredText() }] };
    }

    try {
      const { card } = await sessionClient.getPersonDetails(personId);
      const gender = card.gender || card.genderConclusion?.details?.gender || 'Unknown';
      const { birth, death } = formatCardBirthDeath(card);

      return {
        content: [
          {
            type: 'text',
            text: `Person Details:\nID: ${personId}\nName: ${card.name || 'Unknown'}\nGender: ${gender}\nLifespan: ${card.lifespan || 'Unknown'}\nBirth: ${birth}\nDeath: ${death}`,
          },
        ],
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error fetching person details: ${formatError(error)}` }] };
    }
  },
);

server.tool(
  'get-ancestors',
  'Get ancestors of a specific person',
  {
    personId: z.string().describe('Person ID'),
    generations: z.number().optional().describe('Number of generations (default: 4, max: 8)'),
  },
  async ({ personId, generations = 4 }: { personId: string; generations?: number }) => {
    if (!isAuthenticated()) {
      return { content: [{ type: 'text', text: authRequiredText() }] };
    }

    try {
      const lines = await sessionClient.getAncestors(personId, generations);
      return {
        content: [
          {
            type: 'text',
            text: `Ancestors (${Math.min(generations || 4, 8)} generations):\n\n${lines.join('\n')}`,
          },
        ],
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error fetching ancestors: ${formatError(error)}` }] };
    }
  },
);

server.tool(
  'get-descendants',
  'Get descendants of a specific person',
  {
    personId: z.string().describe('Person ID'),
    generations: z.number().optional().describe('Number of generations (default: 2, max: 3)'),
  },
  async ({ personId, generations = 2 }: { personId: string; generations?: number }) => {
    if (!isAuthenticated()) {
      return { content: [{ type: 'text', text: authRequiredText() }] };
    }

    try {
      const lines = await sessionClient.getDescendants(personId, generations);
      return {
        content: [
          {
            type: 'text',
            text: `Descendants (${Math.min(generations || 2, 3)} generations):\n\n${lines.join('\n')}`,
          },
        ],
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error fetching descendants: ${formatError(error)}` }] };
    }
  },
);

server.tool(
  'search-records',
  'Search for historical records in FamilySearch',
  {
    givenName: z.string().optional().describe('Given name'),
    surname: z.string().optional().describe('Surname/last name'),
    birthDate: z.string().optional().describe('Birth date (YYYY-MM-DD)'),
    birthPlace: z.string().optional().describe('Birth place'),
    deathDate: z.string().optional().describe('Death date (YYYY-MM-DD)'),
    deathPlace: z.string().optional().describe('Death place'),
    collectionId: z.string().optional().describe('Specific collection ID to search in'),
    limit: z.number().optional().describe('Maximum number of results (default: 10)'),
  },
  async (params) => {
    if (!isAuthenticated()) {
      return { content: [{ type: 'text', text: authRequiredText() }] };
    }

    try {
      const records = await sessionClient.searchRecords(params);
      if (!records.length) {
        return { content: [{ type: 'text', text: 'No records found matching your search criteria.' }] };
      }

      const resultsText = records
        .map(
          (record, index) =>
            `${index + 1}. ${record.name} (${record.id})\n   Gender: ${record.gender}\n   Birth: ${record.birth}\n   Death: ${record.death}\n   Collection: ${record.collection}`,
        )
        .join('\n\n');

      return {
        content: [{ type: 'text', text: `Found ${records.length} matching records:\n\n${resultsText}` }],
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error searching records: ${formatError(error)}` }] };
    }
  },
);

const MAX_RANGE = 200;
const OVERRIDE_HINT =
  'Use view-image to read it, or pass ignoreDownloadRestriction=true to save it anyway (against FamilySearch\'s download setting, at your own risk).';

const imageRefSchema = {
  image: z
    .string()
    .optional()
    .describe('Image ARK (3:1:XXXX-XXXX-XXXX-X) or its viewer URL (https://www.familysearch.org/ark:/61903/3:1:…)'),
  film: z
    .string()
    .optional()
    .describe('Instead of image: film / image group (DGS) number or a /search/film/… URL'),
  index: z
    .number()
    .int()
    .optional()
    .describe('With film: image number as the viewer shows it ("Image N of M", 1-based)'),
};

const textResult = (text: string) => ({ content: [{ type: 'text' as const, text }] });

/** Why a full-resolution save is refused, or undefined when it may proceed. */
function downloadRefusal(image: ResolvedImage, ignoreDownloadRestriction: boolean): string | undefined {
  if (image.rights && !image.rights.authorized) {
    return `${image.arkId} is not viewable with this account, so it is not downloaded.`;
  }
  if (image.rights?.allowDownload || ignoreDownloadRestriction) {
    return undefined;
  }
  return `${image.arkId}: access is ${describeRights(image.rights)}, so it was not saved. ${OVERRIDE_HINT}`;
}

async function downloadOne(image: ResolvedImage, outputDir?: string) {
  const filePath = join(resolveDownloadDir(outputDir, image.dgsNum), imageFileName(image));
  if (isSavedJpeg(filePath)) {
    return { filePath, skipped: true as const };
  }
  const data = await sessionClient.fetchImage(image.arkId);
  saveJpeg(filePath, data);
  return { filePath, skipped: false as const, bytes: data.length, size: jpegSize(data) };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

server.tool(
  'get-film-images',
  'List the images of a digitized film (DGS / image group number): catalog titles and the image ARKs in viewer order',
  {
    film: z.string().describe('Film / image group (DGS) number, e.g. 007819272, or a /search/film/… URL'),
    start: z.number().int().optional().describe('First image number to list (1-based, default 1)'),
    count: z.number().int().optional().describe('How many images to list (default 100, max 1000)'),
  },
  async ({ film, start = 1, count = 100 }: { film: string; start?: number; count?: number }) => {
    if (!isAuthenticated()) return textResult(authRequiredText());

    try {
      const images = await sessionClient.getFilmImages(film);
      const first = Math.max(1, start);
      const last = Math.min(images.arkIds.length, first + Math.min(Math.max(count, 1), 1000) - 1);
      const catalogs = images.catalogs
        .map((catalog) => `- ${catalog.title}${catalog.id ? ` (catalog ${catalog.id})` : ''}`)
        .join('\n');
      const lines = images.arkIds
        .slice(first - 1, last)
        .map((arkId, offset) => `${first + offset}. ${arkId}`)
        .join('\n');

      return textResult(
        `Film (DGS) ${images.dgsNum}: ${images.arkIds.length} images\n` +
          `Viewer: https://www.familysearch.org/search/film/${images.dgsNum}?i=<image number - 1>\n` +
          (catalogs ? `Catalog entries on this film:\n${catalogs}\n` : '') +
          `\nImages ${first}-${last}:\n${lines || '(none in this range)'}`,
      );
    } catch (error) {
      return textResult(`Error listing film images: ${formatError(error)}`);
    }
  },
);

server.tool(
  'view-image',
  'Show a record image (film frame) so it can be read or transcribed; works for every image the account may view, without saving a file',
  {
    ...imageRefSchema,
    width: z
      .number()
      .int()
      .optional()
      .describe('Width in pixels of the returned image (default 1600, 200-4000)'),
  },
  async ({ image, film, index, width = 1600 }: { image?: string; film?: string; index?: number; width?: number }) => {
    if (!isAuthenticated()) return textResult(authRequiredText());

    try {
      const resolved = await sessionClient.resolveImage({ image, film, index });
      if (resolved.rights && !resolved.rights.authorized) {
        return textResult(`${describeImage(resolved)}\n\nThis image is not viewable with this account.`);
      }
      const data = await sessionClient.fetchImage(resolved.arkId, Math.min(Math.max(width, 200), 4000));
      const size = jpegSize(data);
      return {
        content: [
          {
            type: 'text' as const,
            text: `${describeImage(resolved)}\nShown at ${size ? `${size.width}×${size.height}` : `width ${width}`} px.`,
          },
          { type: 'image' as const, data: data.toString('base64'), mimeType: 'image/jpeg' },
        ],
      };
    } catch (error) {
      return textResult(`Error viewing image: ${formatError(error)}`);
    }
  },
);

server.tool(
  'download-image',
  'Save one record image (film frame) as a full-resolution JPG. Images FamilySearch marks view-only are refused unless ignoreDownloadRestriction is true',
  {
    ...imageRefSchema,
    outputDir: z
      .string()
      .optional()
      .describe('Folder to save into (default: $FAMILYSEARCH_DOWNLOAD_DIR or ~/Downloads/familysearch, plus /<DGS>)'),
    ignoreDownloadRestriction: z
      .boolean()
      .optional()
      .describe('Also save images FamilySearch marks view-only (allowDownload=false); against its download setting, at your own risk'),
  },
  async ({
    image,
    film,
    index,
    outputDir,
    ignoreDownloadRestriction = false,
  }: {
    image?: string;
    film?: string;
    index?: number;
    outputDir?: string;
    ignoreDownloadRestriction?: boolean;
  }) => {
    if (!isAuthenticated()) return textResult(authRequiredText());

    try {
      const resolved = await sessionClient.resolveImage({ image, film, index });
      const refusal = downloadRefusal(resolved, ignoreDownloadRestriction);
      if (refusal) return textResult(`${describeImage(resolved)}\n\n${refusal}`);

      const saved = await downloadOne(resolved, outputDir);
      const detail = saved.skipped
        ? 'already saved, not downloaded again'
        : `${saved.size ? `${saved.size.width}×${saved.size.height} px, ` : ''}${formatBytes(saved.bytes)}`;
      return textResult(`${describeImage(resolved)}\n\nSaved: ${saved.filePath} (${detail})`);
    } catch (error) {
      return textResult(`Error downloading image: ${formatError(error)}`);
    }
  },
);

server.tool(
  'download-film-images',
  `Save a range of a film's images as full-resolution JPGs (<DGS>_<image number>.jpg), one at a time with a pause; skips files already saved; at most ${MAX_RANGE} images per call. Stops at the first image FamilySearch marks view-only unless ignoreDownloadRestriction is true`,
  {
    film: z.string().describe('Film / image group (DGS) number, e.g. 007819272, or a /search/film/… URL'),
    start: z.number().int().describe('First image number (1-based, as the viewer shows)'),
    end: z.number().int().describe(`Last image number, inclusive (at most ${MAX_RANGE} images per call)`),
    outputDir: z
      .string()
      .optional()
      .describe('Folder to save into (default: $FAMILYSEARCH_DOWNLOAD_DIR or ~/Downloads/familysearch, plus /<DGS>)'),
    ignoreDownloadRestriction: z
      .boolean()
      .optional()
      .describe('Also save images FamilySearch marks view-only (allowDownload=false); against its download setting, at your own risk'),
    delayMs: z.number().int().optional().describe('Pause between downloads in ms (default 1500, minimum 500)'),
  },
  async ({
    film,
    start,
    end,
    outputDir,
    ignoreDownloadRestriction = false,
    delayMs = 1500,
  }: {
    film: string;
    start: number;
    end: number;
    outputDir?: string;
    ignoreDownloadRestriction?: boolean;
    delayMs?: number;
  }) => {
    if (!isAuthenticated()) return textResult(authRequiredText());

    try {
      const images = await sessionClient.getFilmImages(film);
      const total = images.arkIds.length;
      if (start < 1 || end < start || start > total) {
        return textResult(`Film ${images.dgsNum} has ${total} images; choose 1 <= start <= end <= ${total}.`);
      }
      const last = Math.min(end, total, start + MAX_RANGE - 1);
      const pause = Math.max(delayMs, 500);
      const saved: string[] = [];
      const skipped: number[] = [];
      const failed: string[] = [];
      let stopped = '';
      const folder = resolveDownloadDir(outputDir, images.dgsNum);

      for (let index = start; index <= last; index++) {
        const arkId = images.arkIds[index - 1];
        let resolved: ResolvedImage = { arkId, dgsNum: images.dgsNum, index, total };
        try {
          if (!isSavedJpeg(join(folder, imageFileName(resolved)))) {
            resolved = { ...resolved, rights: (await sessionClient.getImageInfo(arkId)).rights };
            const refusal = downloadRefusal(resolved, ignoreDownloadRestriction);
            if (refusal) {
              stopped = `Stopped at image ${index}. ${refusal}`;
              break;
            }
          }
          const result = await downloadOne(resolved, outputDir);
          if (result.skipped) {
            skipped.push(index);
            continue;
          }
          saved.push(`${index}: ${result.filePath} (${formatBytes(result.bytes)})`);
        } catch (error) {
          failed.push(`${index} (${arkId}): ${formatError(error)}`);
          if (error instanceof FamilySearchSessionError && (error.statusCode === 401 || error.statusCode === 403)) {
            stopped = 'Stopped: the session is no longer accepted. Run login-with-browser, then repeat the call.';
            break;
          }
        }
        if (index < last) await sleep(pause);
      }

      const report = [
        `Film (DGS) ${images.dgsNum}, images ${start}-${last} of ${total} → ${folder}`,
        `Saved ${saved.length}, already present ${skipped.length}, failed ${failed.length}.`,
      ];
      if (last < end) report.push(`Only ${MAX_RANGE} images per call: continue with start=${last + 1}.`);
      if (stopped) report.push(stopped);
      if (saved.length) report.push(`\nSaved:\n${saved.join('\n')}`);
      if (failed.length) report.push(`\nFailed:\n${failed.join('\n')}`);
      return textResult(report.join('\n'));
    } catch (error) {
      return textResult(`Error downloading film images: ${formatError(error)}`);
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('FamilySearch server is running');
}

main().catch((error) => {
  console.error('Fatal error in main():', error);
  process.exit(1);
});
