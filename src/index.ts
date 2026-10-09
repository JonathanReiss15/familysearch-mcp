import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { loadConfig, saveConfig, type FamilySearchConfig } from './config.js';
import {
  extractCookieValue,
  FamilySearchSessionClient,
  FamilySearchSessionError,
  formatCardBirthDeath,
  type RecordSearchParams,
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
  'get-family',
  'Get parents, siblings, spouses (with marriage) and children of a person in the Family Tree',
  {
    personId: z.string().describe('Person ID'),
  },
  async ({ personId }: { personId: string }) => {
    if (!isAuthenticated()) {
      return { content: [{ type: 'text', text: authRequiredText() }] };
    }

    try {
      const lines = await sessionClient.getFamily(personId);
      return { content: [{ type: 'text', text: `Family of ${personId}:\n\n${lines.join('\n')}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error fetching family: ${formatError(error)}` }] };
    }
  },
);

server.tool(
  'get-research-suggestions',
  'List ancestors (and the root person\'s children) that have pending record hints (RECORD_HINTS) or FamilySearch research suggestions such as NO_SOURCES_ATTACHED, MISSING_VITAL_EVENT_YEAR or POSSIBLE_CHILD_GAP_AT_END',
  {
    personId: z.string().describe('Root person ID'),
    generations: z.number().optional().describe('Number of ancestor generations (default: 4, max: 8)'),
  },
  async ({ personId, generations = 4 }: { personId: string; generations?: number }) => {
    if (!isAuthenticated()) {
      return { content: [{ type: 'text', text: authRequiredText() }] };
    }

    try {
      const lines = await sessionClient.getResearchSuggestions(personId, generations);
      const text = lines.length ? lines.join('\n') : 'No record hints or research suggestions found.';
      return { content: [{ type: 'text', text: `Research suggestions around ${personId}:\n\n${text}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error fetching research suggestions: ${formatError(error)}` }] };
    }
  },
);

server.tool(
  'get-record',
  'Get a historical record (persona ID from search-records) with collection, all persons and relationships',
  {
    recordId: z.string().describe('Record persona ID'),
  },
  async ({ recordId }: { recordId: string }) => {
    if (!isAuthenticated()) {
      return { content: [{ type: 'text', text: authRequiredText() }] };
    }

    try {
      const lines = await sessionClient.getRecord(recordId);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error fetching record: ${formatError(error)}` }] };
    }
  },
);

server.tool(
  'search-records',
  'Search historical records in FamilySearch. Shows facts with places, the collection and the related persons (spouse, parents, children) of each hit. Years are YYYY; ranges via *From/*To.',
  {
    givenName: z.string().optional().describe('Given name'),
    surname: z.string().optional().describe('Surname/last name'),
    exactSurname: z.boolean().optional().describe('Match the surname exactly (no spelling variants)'),
    gender: z.enum(['MALE', 'FEMALE']).optional().describe('Gender'),
    birthDate: z.string().optional().describe('Birth date/year, open-ended lower bound (legacy)'),
    birthYearFrom: z.string().optional().describe('Birth year range start'),
    birthYearTo: z.string().optional().describe('Birth year range end'),
    birthPlace: z.string().optional().describe('Birth place'),
    deathDate: z.string().optional().describe('Death date/year, open-ended lower bound (legacy)'),
    deathYearFrom: z.string().optional().describe('Death year range start'),
    deathYearTo: z.string().optional().describe('Death year range end'),
    deathPlace: z.string().optional().describe('Death place'),
    marriageYearFrom: z.string().optional().describe('Marriage year range start'),
    marriageYearTo: z.string().optional().describe('Marriage year range end'),
    marriagePlace: z.string().optional().describe('Marriage place'),
    residencePlace: z.string().optional().describe('Residence place'),
    anyPlace: z.string().optional().describe('Any place in the record'),
    spouseGivenName: z.string().optional().describe("Spouse's given name"),
    spouseSurname: z.string().optional().describe("Spouse's surname"),
    fatherGivenName: z.string().optional().describe("Father's given name"),
    fatherSurname: z.string().optional().describe("Father's surname"),
    motherGivenName: z.string().optional().describe("Mother's given name"),
    motherSurname: z.string().optional().describe("Mother's surname"),
    recordCountry: z.string().optional().describe('Restrict to records from this country, e.g. Germany or Poland'),
    collectionId: z.string().optional().describe('Specific collection ID to search in'),
    limit: z.number().optional().describe('Maximum number of results (default: 10, max: 100)'),
    offset: z.number().optional().describe('Result offset for paging'),
  },
  async (params: RecordSearchParams) => {
    if (!isAuthenticated()) {
      return { content: [{ type: 'text', text: authRequiredText() }] };
    }

    try {
      const { total, records } = await sessionClient.searchRecords(params);
      if (!records.length) {
        return { content: [{ type: 'text', text: 'No records found matching your search criteria.' }] };
      }

      const resultsText = records
        .map((record, index) =>
          [
            `${(params.offset || 0) + index + 1}. ${record.name} (${record.id}) — ${record.gender}`,
            `   Collection: ${record.collection}`,
            record.facts ? `   ${record.facts}` : '',
            record.relatives.length ? `   ${record.relatives.join('; ')}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        )
        .join('\n\n');

      return {
        content: [{ type: 'text', text: `Showing ${records.length} of ${total} records:\n\n${resultsText}` }],
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error searching records: ${formatError(error)}` }] };
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
