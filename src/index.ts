import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { loadConfig, saveConfig, type FamilySearchConfig } from './config.js';
import {
  formatChanges,
  formatMemories,
  formatNotes,
  formatPedigree,
  formatPerson,
  formatRecord,
  formatSources,
} from './gedcomx.js';
import { FamilySearchSessionClient, FamilySearchSessionError } from './session-client.js';

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
  version: '2.1.0',
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

const text = (value: string) => ({ content: [{ type: 'text', text: value }] });

/** Runs an authenticated tool body, turning failures into a readable message. */
async function authed(errorLabel: string, body: () => Promise<string>) {
  if (!isAuthenticated()) {
    return text(authRequiredText());
  }
  try {
    return text(await body());
  } catch (error) {
    return text(`Error ${errorLabel}: ${formatError(error)}`);
  }
}

/** Defaults a person ID to the signed-in user's own tree person. */
async function resolvePersonId(personId?: string): Promise<string> {
  if (personId) return personId;
  if (!config.userPersonId) {
    const user = await sessionClient.validateSession();
    config.userPersonId = user.personId;
    persistConfig();
  }
  if (!config.userPersonId) {
    throw new Error('No personId given and your account has no tree person. Pass a personId.');
  }
  return config.userPersonId;
}

const personIdParam = z
  .string()
  .optional()
  .describe("Family Tree person ID (e.g. G2KQ-JTH). Defaults to the signed-in user's own tree person.");

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
      return text('Provide either cookies (full string, recommended) or sessionId.');
    }

    applySessionCookies(cookies || '', sessionId, fsAnid);

    try {
      const user = await sessionClient.validateSession();
      config.userDisplayName = user.displayName;
      config.userPersonId = user.personId;
      persistConfig();

      return text(`Browser session saved. Authenticated as ${user.displayName}${user.personId ? ` (${user.personId})` : ''}.`);
    } catch (error) {
      config.cookies = '';
      config.sessionId = '';
      persistConfig();
      return text(`Session validation failed: ${formatError(error)}`);
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
      return text(`Browser login failed: ${formatError(error)}`);
    }

    config = loadConfig();
    sessionClient.setSession(config.sessionId, config.fsAnid, config.cookies);

    if (!isAuthenticated()) {
      return text('Browser login did not save a session cookie.');
    }

    return text('Browser login complete. Session saved to ~/.familysearch-mcp/config.json.');
  },
);

server.tool(
  'get-current-user',
  'Get the signed-in FamilySearch account (name, email, and own tree person ID). Also confirms the session is valid.',
  {},
  async () =>
    authed('fetching user info', async () => {
      const user = await sessionClient.getCurrentUser();
      config.userDisplayName = user.displayName;
      config.userPersonId = user.personId;
      persistConfig();
      return [
        `Signed in as: ${user.displayName}`,
        `Full name: ${user.fullName}`,
        `Email: ${user.email}`,
        `Tree person ID: ${user.personId || 'None'}`,
      ].join('\n');
    }),
);

server.tool(
  'search-persons',
  'Search the Family Tree for people (tree profiles, not historical records)',
  {
    name: z.string().optional().describe('Name to search for'),
    birthDate: z.string().optional().describe('Birth date (YYYY-MM-DD)'),
    birthPlace: z.string().optional().describe('Birth place'),
    deathDate: z.string().optional().describe('Death date (YYYY-MM-DD)'),
    deathPlace: z.string().optional().describe('Death place'),
    gender: z.enum(['MALE', 'FEMALE']).optional().describe('Gender'),
    limit: z.number().optional().describe('Maximum number of results (default: 10)'),
  },
  async (params) =>
    authed('searching persons', async () => {
      const persons = await sessionClient.searchPersons(params);
      if (!persons.length) {
        return 'No persons found matching your search criteria.';
      }

      const resultsText = persons
        .map(
          (person, index) =>
            `${index + 1}. ${person.name} (${person.id})\n   Gender: ${person.gender}\n   Birth: ${person.birth}\n   Death: ${person.death}`,
        )
        .join('\n\n');
      return `Found ${persons.length} matching people:\n\n${resultsText}`;
    }),
);

server.tool(
  'get-person',
  'Get a Family Tree person: names, all facts (birth, death, residences, etc.), parents, siblings, spouses with marriage details, and children',
  { personId: personIdParam },
  async ({ personId }: { personId?: string }) =>
    authed('fetching person', async () => {
      const id = await resolvePersonId(personId);
      return formatPerson(await sessionClient.getPersonWithFamily(id), id);
    }),
);

server.tool(
  'get-ancestors',
  'Get the ancestors (pedigree) of a person, numbered Ahnentafel-style (1 = person, 2 = father, 3 = mother, ...)',
  {
    personId: personIdParam,
    generations: z.number().optional().describe('Number of generations (default: 4, max: 8)'),
  },
  async ({ personId, generations = 4 }: { personId?: string; generations?: number }) =>
    authed('fetching ancestors', async () => {
      const id = await resolvePersonId(personId);
      const doc = await sessionClient.getAncestry(id, generations);
      return `Ancestors (${Math.min(generations, 8)} generations):\n\n${formatPedigree(doc, 'ancestry')}`;
    }),
);

server.tool(
  'get-descendants',
  'Get the descendants of a person, with spouses, numbered by line (1.2.1 = first child of second child)',
  {
    personId: personIdParam,
    generations: z.number().optional().describe('Number of generations (default: 2, max: 4)'),
  },
  async ({ personId, generations = 2 }: { personId?: string; generations?: number }) =>
    authed('fetching descendants', async () => {
      const id = await resolvePersonId(personId);
      const doc = await sessionClient.getDescendancy(id, generations);
      return `Descendants (${Math.min(generations, 4)} generations):\n\n${formatPedigree(doc, 'descendancy')}`;
    }),
);

server.tool(
  'relationship-to-me',
  'Explain how the signed-in user is related to a Family Tree person, with the full path between them',
  { personId: z.string().describe('Family Tree person ID') },
  async ({ personId }: { personId: string }) =>
    authed('fetching relationship', async () => {
      const relationship = await sessionClient.getRelationshipToMe(personId);
      if (!relationship.steps.length) {
        return relationship.description || 'No relationship found between you and this person.';
      }
      const path = relationship.steps.map(
        (step) =>
          `${step.relation || 'Me'}: ${step.name} (${step.lifespan || '?'}) [${step.id}]${step.commonAncestor ? ' — common ancestor' : ''}`,
      );
      return `${relationship.description}\n\nPath:\n${path.join('\n')}`;
    }),
);

server.tool(
  'get-sources',
  'List the sources (historical records, documents) attached to a Family Tree person. Record IDs can be opened with get-record.',
  { personId: personIdParam },
  async ({ personId }: { personId?: string }) =>
    authed('fetching sources', async () => formatSources(await sessionClient.getSources(await resolvePersonId(personId)))),
);

server.tool(
  'get-record',
  'Read a full historical record (census, vital, etc.): every person on it with ages, relationships, and events',
  {
    recordId: z
      .string()
      .describe('Record persona ID (e.g. M67N-1Z7), "1:1:" ID, or ark URL from search-records, get-sources, or get-record-hints'),
  },
  async ({ recordId }: { recordId: string }) =>
    authed('fetching record', async () => formatRecord(await sessionClient.getRecord(recordId))),
);

server.tool(
  'get-memories',
  'List the memories (photos, stories, documents, audio) attached to a Family Tree person',
  { personId: personIdParam },
  async ({ personId }: { personId?: string }) =>
    authed('fetching memories', async () => formatMemories(await sessionClient.getMemories(await resolvePersonId(personId)))),
);

server.tool(
  'get-notes',
  'Read the research notes on a Family Tree person',
  { personId: personIdParam },
  async ({ personId }: { personId?: string }) =>
    authed('fetching notes', async () => formatNotes(await sessionClient.getNotes(await resolvePersonId(personId)))),
);

server.tool(
  'get-change-history',
  'See who changed a Family Tree person, when, and why (newest first)',
  {
    personId: z.string().describe('Family Tree person ID'),
    limit: z.number().optional().describe('Maximum number of changes to show (default: 25)'),
  },
  async ({ personId, limit = 25 }: { personId: string; limit?: number }) =>
    authed('fetching change history', async () => formatChanges(await sessionClient.getChanges(personId), limit)),
);

server.tool(
  'get-record-hints',
  "FamilySearch's suggested historical records that may match a Family Tree person (open with get-record)",
  { personId: z.string().describe('Family Tree person ID') },
  async ({ personId }: { personId: string }) =>
    authed('fetching record hints', async () => {
      const hints = await sessionClient.getRecordHints(personId);
      if (!hints.length) {
        return 'No record hints for this person.';
      }
      return hints
        .map((hint, index) => {
          const recordId = hint.recordUrl?.match(/1:1:([A-Z0-9-]+)/)?.[1];
          const lines = [`${index + 1}. ${hint.personName || 'Unknown'} — ${hint.collectionTitle || 'Unknown collection'}`];
          if (hint.score !== undefined) lines.push(`   Match score: ${Math.round(hint.score * 100)}%`);
          for (const event of hint.events || []) {
            lines.push(`   ${[event.type, event.date, event.place].filter(Boolean).join(' — ')}`);
          }
          if (hint.relations?.length) {
            lines.push(`   Related: ${hint.relations.map((r) => `${r.name} (${(r.type || '').toLowerCase()})`).join(', ')}`);
          }
          if (recordId) lines.push(`   Record ID: ${recordId}`);
          return lines.join('\n');
        })
        .join('\n\n');
    }),
);

server.tool(
  'get-data-quality',
  "FamilySearch's data-quality check for a Family Tree person: scores plus specific issues like date conflicts, name mismatches with sources, and untagged facts",
  { personId: z.string().describe('Family Tree person ID') },
  async ({ personId }: { personId: string }) =>
    authed('fetching data quality', async () => {
      const scores = await sessionClient.getDataQuality(personId);
      if (!scores) {
        return 'Quality scores are still being calculated for this person. Try again in a few seconds.';
      }
      const pct = (value?: number) => (value === undefined ? '?' : `${Math.round(value * 100)}%`);
      const lines = [
        `Overall: ${pct(scores.overallDisplayScore)}`,
        `Completeness: ${pct(scores.completenessScore?.displayScore)} · Consistency: ${pct(scores.consistencyScore?.displayScore)} · Coherence: ${pct(scores.coherenceScore?.displayScore)} · Verifiability: ${pct(scores.verifiabilityScore?.displayScore)}`,
      ];
      const issues = scores.issues || [];
      lines.push('', issues.length ? `Issues (${issues.length}):` : 'No issues found.');
      for (const issue of issues) {
        const detail = [
          issue.conclusionName || issue.conclusionOriginalDate ? `tree: ${issue.conclusionName || issue.conclusionOriginalDate}` : '',
          issue.sourceName || issue.sourceOriginalDate ? `source: ${issue.sourceName || issue.sourceOriginalDate}` : '',
          issue.sourceTitle ? `in ${issue.sourceTitle}` : '',
        ].filter(Boolean);
        lines.push(
          `- ${issue.issueType || 'Issue'}${issue.conclusionType ? ` (${issue.conclusionType})` : ''}${detail.length ? `: ${detail.join('; ')}` : ''}`,
        );
      }
      return lines.join('\n');
    }),
);

server.tool(
  'search-records',
  'Search indexed historical records. Relative names (spouse, parents) and places rank better matches higher rather than filtering strictly. Open results with get-record.',
  {
    givenName: z.string().optional().describe('Given name'),
    surname: z.string().optional().describe('Surname/last name'),
    birthDate: z.string().optional().describe('Birth year or date'),
    birthPlace: z.string().optional().describe('Birth place'),
    deathDate: z.string().optional().describe('Death year or date'),
    deathPlace: z.string().optional().describe('Death place'),
    marriageDate: z.string().optional().describe('Marriage year or date'),
    marriagePlace: z.string().optional().describe('Marriage place'),
    residencePlace: z.string().optional().describe('Any place the person lived'),
    spouseGivenName: z.string().optional().describe("Spouse's given name"),
    spouseSurname: z.string().optional().describe("Spouse's surname"),
    fatherGivenName: z.string().optional().describe("Father's given name"),
    fatherSurname: z.string().optional().describe("Father's surname"),
    motherGivenName: z.string().optional().describe("Mother's given name"),
    motherSurname: z.string().optional().describe("Mother's surname"),
    collectionId: z.string().optional().describe('Restrict to one collection (find IDs with search-collections)'),
    limit: z.number().optional().describe('Maximum number of results (default: 10)'),
    offset: z.number().optional().describe('Results to skip, for paging (default: 0)'),
  },
  async (params: Parameters<typeof sessionClient.searchRecords>[0]) =>
    authed('searching records', async () => {
      const { total, records } = await sessionClient.searchRecords(params);
      if (!records.length) {
        return 'No records found matching your search criteria.';
      }

      const offset = params.offset || 0;
      const resultsText = records
        .map(
          (record, index) =>
            `${offset + index + 1}. ${record.name} (${record.id})\n   Record: ${record.record}\n   Gender: ${record.gender}\n   Birth: ${record.birth}\n   Death: ${record.death}\n   Collection: ${record.collection}`,
        )
        .join('\n\n');
      return `Showing ${offset + 1}–${offset + records.length} of ${total.toLocaleString()} records:\n\n${resultsText}`;
    }),
);

server.tool(
  'search-fulltext',
  'Search the full text of handwritten documents (wills, deeds, court and land records) transcribed by FamilySearch. Wrap a phrase in double quotes for an exact match, e.g. "John Smith".',
  {
    text: z.string().describe('Words to find; use "double quotes" for an exact phrase'),
    collectionId: z.string().optional().describe('Restrict to one full-text collection'),
    limit: z.number().optional().describe('Maximum number of results (default: 10)'),
    offset: z.number().optional().describe('Results to skip, for paging (default: 0)'),
  },
  async (params: { text: string; collectionId?: string; limit?: number; offset?: number }) =>
    authed('searching full text', async () => {
      const { total, documents } = await sessionClient.searchFullText(params);
      if (!documents.length) {
        return 'No documents found.';
      }
      const offset = params.offset || 0;
      const resultsText = documents
        .map(
          (doc, index) =>
            `${offset + index + 1}. ${doc.title}\n   Collection: ${doc.collection}\n   URL: ${doc.url}\n   Excerpt: ${doc.excerpt}`,
        )
        .join('\n\n');
      return `Showing ${offset + 1}–${offset + documents.length} of ${total.toLocaleString()} documents:\n\n${resultsText}`;
    }),
);

server.tool(
  'search-collections',
  'Find historical record collections by keyword (e.g. "Kansas marriages", "Ireland census") and/or a year they cover. Use the collection ID with search-records.',
  {
    query: z.string().optional().describe('Words that must all appear in the collection title or region'),
    year: z.number().optional().describe('Only collections covering this year'),
    limit: z.number().optional().describe('Maximum number of results (default: 20)'),
  },
  async (params: { query?: string; year?: number; limit?: number }) =>
    authed('searching collections', async () => {
      const { total, collections } = await sessionClient.searchCollections(params);
      if (!collections.length) {
        return 'No collections matched.';
      }
      const resultsText = collections
        .map((c) => {
          const years = c.startYear || c.endYear ? `${c.startYear ?? '?'}–${c.endYear ?? '?'}` : 'years unknown';
          return `${c.title} [${c.id}]\n   ${years} · ${c.recordCount.toLocaleString()} records · ${c.imageCount.toLocaleString()} images`;
        })
        .join('\n\n');
      return `${total} collections matched${total > collections.length ? `, largest ${collections.length} shown` : ''}:\n\n${resultsText}`;
    }),
);

server.tool(
  'search-catalog',
  'Search the FamilySearch Library catalog (books, microfilm, record sets) by keywords such as a place, surname, or record type',
  {
    keywords: z.string().describe('Keywords, e.g. "Cook County Illinois naturalization"'),
    limit: z.number().optional().describe('Maximum number of results (default: 10)'),
    offset: z.number().optional().describe('Results to skip, for paging (default: 0)'),
  },
  async (params: { keywords: string; limit?: number; offset?: number }) =>
    authed('searching catalog', async () => {
      const { total, items } = await sessionClient.searchCatalog(params);
      if (!items.length) {
        return 'No catalog items found.';
      }
      const offset = params.offset || 0;
      const resultsText = items
        .map((item, index) => {
          const lines = [`${offset + index + 1}. ${item.title}`];
          if (item.creators.length) lines.push(`   By: ${item.creators.join('; ')}`);
          if (item.repositories.length) lines.push(`   Held at: ${item.repositories.join(', ')}`);
          if (item.url) lines.push(`   URL: ${item.url}`);
          return lines.join('\n');
        })
        .join('\n\n');
      return `Showing ${offset + 1}–${offset + items.length} of ${total.toLocaleString()} catalog items:\n\n${resultsText}`;
    }),
);

server.tool(
  'standardize-place',
  "Match a place name to FamilySearch's standard places (full jurisdiction, type, years it existed, coordinates). Useful before searching.",
  {
    name: z.string().describe('Place name, e.g. "Salt Lake City" or "Cork, Ireland"'),
    limit: z.number().optional().describe('Maximum number of matches (default: 5)'),
  },
  async ({ name, limit = 5 }: { name: string; limit?: number }) =>
    authed('standardizing place', async () => {
      const places = await sessionClient.searchPlaces(name, limit);
      if (!places.length) {
        return 'No matching standard places.';
      }
      return places
        .map((place, index) => {
          const details = [place.type, place.existed ? `existed ${place.existed}` : '', place.coordinates].filter(Boolean);
          return `${index + 1}. ${place.name} [${place.id}]${details.length ? `\n   ${details.join(' · ')}` : ''}`;
        })
        .join('\n');
    }),
);

server.tool(
  'standardize-date',
  'Interpret a genealogical date (e.g. "abt 1869", "bef 3 Mar 1820", "1840-1845") into FamilySearch\'s standard form',
  { date: z.string().describe('Date text to interpret') },
  async ({ date }: { date: string }) =>
    authed('standardizing date', async () => {
      const dates = await sessionClient.interpretDate(date);
      if (!dates.length) {
        return `Could not interpret "${date}".`;
      }
      return dates
        .map(
          (d) =>
            `${d.original} → ${d.standard}\n   Formal: ${d.formal || 'n/a'}${d.precision ? ` · Precision: ${d.precision}` : ''}${d.approximate ? ' · Approximate' : ''}`,
        )
        .join('\n');
    }),
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
