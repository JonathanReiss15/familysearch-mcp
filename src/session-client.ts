const BASE_URL = 'https://www.familysearch.org';

export class FamilySearchSessionError extends Error {
  constructor(message: string, public statusCode?: number) {
    super(message);
    this.name = 'FamilySearchSessionError';
  }
}

interface CardEventDetails {
  date?: { originalText?: string; localizedText?: string };
  place?: { originalText?: string; localizedText?: string };
}

interface CardEvent {
  details?: CardEventDetails;
}

export interface PersonCard {
  id?: string;
  name?: string;
  gender?: string;
  lifespan?: string;
  birth?: CardEvent;
  death?: CardEvent;
  living?: boolean;
  mePersonCisId?: string;
  genderConclusion?: { details?: { gender?: string } };
}

export function formatCardEvent(event?: CardEvent): { date?: string; place?: string } {
  return {
    date: event?.details?.date?.localizedText || event?.details?.date?.originalText,
    place: event?.details?.place?.localizedText || event?.details?.place?.originalText,
  };
}

export function formatCardBirthDeath(card: PersonCard): { birth: string; death: string } {
  const birthDetails = formatCardEvent(card.birth);
  const birth =
    birthDetails.date || birthDetails.place
      ? `${birthDetails.date || 'Unknown date'} - ${birthDetails.place || 'Unknown place'}`
      : 'Unknown';

  if (card.living) {
    return { birth, death: 'Living' };
  }

  const deathDetails = formatCardEvent(card.death);
  const death =
    deathDetails.date || deathDetails.place
      ? `${deathDetails.date || 'Unknown date'} - ${deathDetails.place || 'Unknown place'}`
      : 'Unknown';

  return { birth, death };
}

export interface SessionClientOptions {
  sessionId?: string;
  fsAnid?: string;
  cookies?: string;
}

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36';

export class FamilySearchSessionClient {
  private cookies: string;
  private sessionId: string;

  constructor(options: SessionClientOptions) {
    this.cookies = options.cookies || buildCookieHeader(options.sessionId, options.fsAnid);
    this.sessionId = options.sessionId || extractCookieValue(this.cookies, 'fssessionid');
  }

  isAuthenticated(): boolean {
    return Boolean(this.cookies);
  }

  setSession(sessionId: string, fsAnid?: string, cookies?: string): void {
    this.cookies = cookies || buildCookieHeader(sessionId, fsAnid);
    this.sessionId = sessionId || extractCookieValue(this.cookies, 'fssessionid');
  }

  private cookieHeader(): string {
    return this.cookies;
  }

  private async platformRequest<T>(path: string): Promise<T> {
    if (!this.sessionId) {
      throw new FamilySearchSessionError('No fssessionid in session cookies. Re-run login-with-browser.', 401);
    }
    return this.request<T>(path, undefined, {
      Accept: 'application/x-gedcomx-v1+json',
      Authorization: `Bearer ${this.sessionId}`,
    });
  }

  private async request<T>(
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    if (!this.cookies) {
      throw new FamilySearchSessionError('Not authenticated. Set a browser session cookie first.');
    }

    const url = new URL(path.startsWith('http') ? path : `${BASE_URL}${path}`);
    // Absolute URLs can come from API responses; never send the session to another host.
    if (url.protocol !== 'https:' || (url.hostname !== 'familysearch.org' && !url.hostname.endsWith('.familysearch.org'))) {
      throw new FamilySearchSessionError(`Refusing to send session to ${url.origin} (only https://*.familysearch.org)`);
    }
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '') {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        Cookie: this.cookieHeader(),
        Referer: 'https://www.familysearch.org/en/',
        'User-Agent': BROWSER_USER_AGENT,
        ...extraHeaders,
      },
    });

    const text = await response.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new FamilySearchSessionError(
        `Invalid JSON response (${response.status}) from ${path}: ${text.slice(0, 200)}`,
        response.status,
      );
    }

    if (!response.ok) {
      const message =
        typeof data === 'object' &&
        data !== null &&
        ('message' in data ? String((data as { message?: string }).message) : JSON.stringify(data));
      throw new FamilySearchSessionError(message || `Request failed with status ${response.status}`, response.status);
    }

    if (
      typeof data === 'object' &&
      data !== null &&
      'status' in data &&
      (data as { status?: string }).status === 'UNAUTHORIZED'
    ) {
      throw new FamilySearchSessionError(String((data as { message?: string }).message || 'Session expired'), 401);
    }

    if (
      typeof data === 'object' &&
      data !== null &&
      'errorCode' in data &&
      String((data as { errorCode?: string | number }).errorCode) === '15'
    ) {
      throw new FamilySearchSessionError(
        'Request blocked by FamilySearch security (error 15). Re-run login-with-browser to refresh cookies.',
        403,
      );
    }

    return data as T;
  }

  async validateSession(fallback?: {
    displayName?: string;
    personId?: string;
  }): Promise<{ displayName: string; personId: string; cisId: string }> {
    if (fallback?.personId) {
      try {
        const person = await this.getPersonCard(fallback.personId);
        return {
          displayName: person.name || fallback.displayName || 'Authenticated FamilySearch user',
          personId: fallback.personId,
          cisId: person.mePersonCisId || '',
        };
      } catch {
        // Fall through to search-based validation.
      }
    }
    const data = await this.request<{
      entries?: Array<{
        content?: {
          gedcomx?: {
            persons?: Array<{
              id?: string;
              names?: Array<{ nameForms?: Array<{ fullText?: string }> }>;
            }>;
          };
        };
      }>;
    }>('/service/search/tree/v2/personas', {
      count: 1,
      offset: 0,
      'q.givenName': 'John',
      'q.surname': 'Smith',
    });

    if (!data.entries?.length) {
      throw new FamilySearchSessionError('Session cookie is invalid or expired', 401);
    }

    return {
      displayName: fallback?.displayName || 'Authenticated FamilySearch user',
      personId: fallback?.personId || '',
      cisId: '',
    };
  }

  async searchPersons(params: {
    name?: string;
    birthDate?: string;
    birthPlace?: string;
    deathDate?: string;
    deathPlace?: string;
    gender?: 'MALE' | 'FEMALE';
    limit?: number;
  }) {
    const query: Record<string, string | number> = {
      count: params.limit || 10,
      offset: 0,
      'm.defaultFacets': 'on',
    };

    if (params.name) {
      const parts = params.name.trim().split(/\s+/);
      if (parts.length === 1) {
        query['q.surname'] = parts[0];
      } else {
        query['q.givenName'] = parts.slice(0, -1).join(' ');
        query['q.surname'] = parts[parts.length - 1];
      }
    }

    if (params.birthDate) query['q.birthLikeDate.from'] = params.birthDate;
    if (params.birthPlace) query['q.birthLikePlace'] = params.birthPlace;
    if (params.deathDate) query['q.deathLikeDate.from'] = params.deathDate;
    if (params.deathPlace) query['q.deathLikePlace'] = params.deathPlace;
    if (params.gender) query['q.sex'] = params.gender === 'MALE' ? 'Male' : 'Female';

    const data = await this.request<{
      entries?: Array<{
        id?: string;
        title?: string;
        content?: {
          gedcomx?: {
            persons?: Array<{
              gender?: { type?: string };
              names?: Array<{ nameForms?: Array<{ fullText?: string }> }>;
              facts?: Array<{
                type?: string;
                date?: { original?: string };
                place?: { original?: string };
              }>;
            }>;
          };
        };
      }>;
    }>('/service/search/tree/v2/personas', query);

    return (data.entries || []).map((entry) => {
      const person = entry.content?.gedcomx?.persons?.[0];
      const birthEvent = person?.facts?.find((fact) => fact.type === 'http://gedcomx.org/Birth');
      const deathEvent = person?.facts?.find((fact) => fact.type === 'http://gedcomx.org/Death');

      return {
        id: entry.id || 'Unknown',
        name: person?.names?.[0]?.nameForms?.[0]?.fullText || entry.title || 'Unknown',
        gender: person?.gender?.type?.replace('http://gedcomx.org/', '') || 'Unknown',
        birth: birthEvent
          ? `${birthEvent.date?.original || 'Unknown date'} - ${birthEvent.place?.original || 'Unknown place'}`
          : 'Unknown',
        death: deathEvent
          ? `${deathEvent.date?.original || 'Unknown date'} - ${deathEvent.place?.original || 'Unknown place'}`
          : 'Unknown',
      };
    });
  }

  async getPersonCard(personId: string): Promise<PersonCard> {
    return this.request<PersonCard>(`/service/tree/tree-data/v8/person/${personId}/card`, { treeId: 'PRIVATE' });
  }

  async getPersonDetails(personId: string) {
    const [card, notes] = await Promise.all([
      this.getPersonCard(personId),
      this.request<{ notes?: unknown[] }>(`/service/tree/tree-data/v8/person/${personId}/notes/all`).catch(() => ({ notes: [] })),
    ]);

    return { card, notes: notes.notes || [] };
  }

  async getFamilyMembers(personId: string) {
    return this.request<{
      parents?: FamilyGroup[];
      spouses?: FamilyGroup[];
    }>(`/service/tree/tree-data/r9/family-members/person/${personId}`, {
      includePhotos: false,
      treeId: 'PRIVATE',
    });
  }

  async getFamily(personId: string) {
    const family = await this.getFamilyMembers(personId);
    const lines: string[] = [];

    for (const group of family.parents || []) {
      lines.push(`Parents: ${formatSummary(group.parent1)} & ${formatSummary(group.parent2)}${formatMarriage(group)}`);
      for (const { child } of group.children || []) {
        if (child?.id && child.id !== personId) lines.push(`  Sibling: ${formatSummary(child)}`);
      }
    }

    for (const group of family.spouses || []) {
      const spouse = group.parent1?.id === personId ? group.parent2 : group.parent1;
      lines.push(`Spouse: ${formatSummary(spouse)}${formatMarriage(group)}`);
      for (const { child } of group.children || []) {
        if (child?.id) lines.push(`  Child: ${formatSummary(child)}`);
      }
    }

    return lines.length ? lines : ['No family members found.'];
  }

  // The platform /matches endpoint answers 204 for every person, so hints come from the pedigree view.
  async getResearchSuggestions(personId: string, generations = 4) {
    const data = await this.request<{ ancestors?: PedigreeCouple[][]; children?: PedigreeCouple[] }>(
      `/service/tree/tree-data/r9/portrait-pedigree/${personId}`,
      {
        numGenerations: Math.min(Math.max(generations, 1), 8),
        treeId: 'PRIVATE',
        includePhotos: false,
        includeTempleRollupStatus: false,
        includeRecordHints: true,
        includeSpouseAncestry: false,
      },
    );

    const people = new Map<string, PedigreePerson>();
    const coupleLines: string[] = [];
    for (const couple of [...(data.ancestors || []).flat(), ...(data.children || [])]) {
      for (const person of [couple.parent1, couple.parent2]) {
        if (person?.id && !people.has(person.id)) people.set(person.id, person);
      }
      const names = suggestionNames(couple);
      if (names.length) {
        coupleLines.push(`- Couple ${couple.parent1?.name || '?'} & ${couple.parent2?.name || '?'}: ${names.join(', ')}`);
      }
    }

    const lines: string[] = [];
    for (const person of people.values()) {
      const flags = [...(person.hasRecordHints ? ['RECORD_HINTS'] : []), ...suggestionNames(person)];
      if (flags.length) lines.push(`- ${formatSummary(person)}: ${flags.join(', ')}`);
    }
    return [...lines, ...coupleLines];
  }

  async getRecord(recordId: string) {
    const persona = await this.platformRequest<GedcomxRecord>(`/platform/records/personas/${recordId}`);

    // A persona only carries its own person; the full record (all persons and relationships) sits behind 1:2 ark.
    const recordUrl = persona.sourceDescriptions?.find((sd) => sd.resourceType === 'http://gedcomx.org/Record')?.about;
    let record: GedcomxRecord | undefined;
    if (recordUrl) {
      record = await this.platformRequest<GedcomxRecord>(recordUrl).catch(() => undefined);
    }
    const source = record?.persons?.length ? record : persona;

    const lines = [`Record: ${recordId}`, `Collection: ${collectionTitle(persona) || 'Unknown'}`];
    const citation = persona.sourceDescriptions?.find((sd) => sd.citations?.length)?.citations?.[0]?.value;
    if (citation) lines.push(`Citation: ${citation.replace(/<[^>]+>/g, '')}`);
    const image = persona.sourceDescriptions?.find((sd) => sd.resourceType === 'http://gedcomx.org/DigitalArtifact')?.about;
    if (image) lines.push(`Image: ${image}`);

    const names = new Map<string, string>();
    for (const person of source.persons || []) {
      names.set(person.id || '', personName(person));
    }

    lines.push('', 'Persons:');
    for (const person of source.persons || []) {
      const gender = gedcomxType(person.gender?.type) || '';
      const role = person.principal ? ' [principal]' : '';
      lines.push(`- ${personName(person)}${gender ? ` (${gender})` : ''}${role}`);
      const facts = formatFacts(person);
      if (facts) lines.push(`    ${facts}`);
      const fields = formatFields(person.fields);
      if (fields) lines.push(`    ${fields}`);
    }

    if (source.relationships?.length) {
      lines.push('', 'Relationships:');
      for (const rel of source.relationships) {
        const p1 = names.get(resourceId(rel.person1)) || rel.person1?.resource || '?';
        const p2 = names.get(resourceId(rel.person2)) || rel.person2?.resource || '?';
        const type = gedcomxType(rel.type) || 'Relationship';
        const facts = (rel.facts || []).map(formatFact).join('; ');
        lines.push(`- ${type}: ${p1} → ${p2}${facts ? ` (${facts})` : ''}`);
      }
    }

    return lines;
  }

  async getAncestors(personId: string, generations = 4) {
    const gens = Math.min(Math.max(generations, 1), 8);
    const data = await this.request<{ ancestors?: PedigreeCouple[][] }>(
      `/service/tree/tree-data/r9/portrait-pedigree/${personId}`,
      {
        numGenerations: gens,
        treeId: 'PRIVATE',
        includePhotos: false,
        includeTempleRollupStatus: false,
        includeFullHasSiblings: true,
        includeRecordHints: false,
        includeSpouseAncestry: false,
      },
    );

    const lines: string[] = [];
    const seen = new Set<string>([personId]);
    const formatPerson = (person?: PersonSummary) => {
      if (!person) return 'Unknown';
      const year = person.lifespan?.match(/\d{4}/)?.[0] || person.birth?.date?.match(/\d{4}/)?.[0] || '?';
      return `${person.name || 'Unknown'} (${year}) [${person.id || '?'}]`;
    };
    const addAncestor = (person: PersonSummary | undefined, generation: number) => {
      if (!person?.id || seen.has(person.id)) return;
      seen.add(person.id);
      const prefix = '  '.repeat(generation);
      const relation = person.gender === 'FEMALE' ? 'Mother' : person.gender === 'MALE' ? 'Father' : 'Ancestor';
      lines.push(`${prefix}${relation}: ${formatPerson(person)}`);
    };

    if (!data.ancestors?.length) {
      return [`No ancestors found for person ${personId}`];
    }

    const rootCouple = data.ancestors[0]?.[0];
    const rootPerson = rootCouple?.parent1?.id === personId ? rootCouple.parent1 : rootCouple?.parent2;
    lines.push(`Root: ${formatPerson(rootPerson || { id: personId, name: 'Unknown' })}`);

    for (let generation = 1; generation < data.ancestors.length; generation++) {
      const couples = data.ancestors[generation] || [];
      for (const couple of couples) {
        addAncestor(couple.parent1, generation);
        addAncestor(couple.parent2, generation);
      }
    }

    return lines;
  }

  async getDescendants(personId: string, generations = 2) {
    const gens = Math.min(Math.max(generations, 1), 3);
    const lines: string[] = [];
    const visited = new Set<string>();

    const formatPerson = (person?: PersonSummary) => {
      if (!person) return 'Unknown';
      const year = person.lifespan?.match(/\d{4}/)?.[0] || '?';
      return `${person.name || 'Unknown'} (${year}) [${person.id || '?'}]`;
    };

    const walk = async (currentId: string, depth: number, prefix: string) => {
      if (depth > gens || visited.has(currentId)) return;
      visited.add(currentId);

      const family = await this.getFamilyMembers(currentId);
      const children = new Map<string, PersonSummary>();

      // Only spouse groups hold the person's own children; parent groups hold siblings.
      for (const spouseGroup of family.spouses || []) {
        for (const entry of spouseGroup.children || []) {
          if (entry.child?.id) children.set(entry.child.id, entry.child);
        }
      }

      for (const child of children.values()) {
        lines.push(`${prefix}Child: ${formatPerson(child)}`);
        if (depth < gens && child.id) {
          await walk(child.id, depth + 1, prefix + '  ');
        }
      }
    };

    const root = await this.getPersonCard(personId);
    lines.push(`Root: ${formatPerson({ id: personId, name: root.name, lifespan: root.lifespan })}`);
    await walk(personId, 1, '');

    if (lines.length === 1) {
      lines.push('  No descendants found.');
    }

    return lines;
  }

  async searchRecords(params: RecordSearchParams) {
    const query: Record<string, string | number> = {
      count: Math.min(params.limit || 10, 100),
      offset: params.offset || 0,
      'm.defaultFacets': 'on',
      'm.facetNestCollectionInCategory': 'on',
      'm.queryRequireDefault': 'on',
    };

    for (const [param, key] of RECORD_SEARCH_PARAMS) {
      const value = params[param];
      if (value) query[key] = value;
    }
    // A single birth/death date used to be passed as an open-ended "from"; keep that for old callers.
    if (params.birthDate && !params.birthYearFrom) query['q.birthLikeDate.from'] = params.birthDate;
    if (params.deathDate && !params.deathYearFrom) query['q.deathLikeDate.from'] = params.deathDate;
    if (params.exactSurname) query['q.surname.exact'] = 'on';
    if (params.gender) query['q.sex'] = params.gender === 'MALE' ? 'Male' : 'Female';

    const data = await this.request<{
      results?: number;
      entries?: Array<{ id?: string; title?: string; content?: { gedcomx?: GedcomxRecord & { description?: { title?: string } } } }>;
    }>('/service/search/hr/v2/personas', query);

    const records = (data.entries || []).map((record) => {
      const gedcomx = record.content?.gedcomx;
      const principal = gedcomx?.persons?.find((p) => p.principal) || gedcomx?.persons?.[0];
      return {
        id: record.id || 'Unknown',
        name: principal ? personName(principal) : record.title || 'Unknown',
        gender: gedcomxType(principal?.gender?.type) || 'Unknown',
        facts: principal ? formatFacts(principal) : '',
        relatives: principal && gedcomx ? describeRelatives(gedcomx, principal) : [],
        collection: collectionTitle(gedcomx) || gedcomx?.description?.title || 'Unknown collection',
      };
    });

    return { total: data.results ?? records.length, records };
  }
}

interface PersonSummary {
  id?: string;
  name?: string;
  gender?: string;
  lifespan?: string;
  fullLifespan?: string;
  birth?: { date?: string; place?: string };
}

interface SuggestionHolder {
  suggestions?: {
    researchSuggestionList?: Array<{ type?: { name?: string } }> | null;
    dataQualityList?: Array<{ type?: { name?: string } }> | null;
  };
}

interface PedigreePerson extends PersonSummary, SuggestionHolder {
  hasRecordHints?: boolean;
}

interface PedigreeCouple extends SuggestionHolder {
  parent1?: PedigreePerson;
  parent2?: PedigreePerson;
}

function suggestionNames(holder: SuggestionHolder): string[] {
  return [...(holder.suggestions?.researchSuggestionList || []), ...(holder.suggestions?.dataQualityList || [])]
    .map((suggestion) => suggestion.type?.name)
    .filter((name): name is string => Boolean(name));
}

interface FamilyGroup {
  parent1?: PersonSummary;
  parent2?: PersonSummary;
  children?: Array<{ child?: PersonSummary }>;
  event?: {
    details?: {
      date?: { originalText?: string; normalizedText?: string };
      place?: { originalText?: string; normalizedText?: string };
    };
  };
}

interface GedcomxFact {
  type?: string;
  date?: { original?: string };
  place?: { original?: string };
  value?: string;
}

interface GedcomxPerson {
  id?: string;
  principal?: boolean;
  gender?: { type?: string };
  names?: Array<{ nameForms?: Array<{ fullText?: string }> }>;
  facts?: GedcomxFact[];
  fields?: Array<{ type?: string; values?: Array<{ type?: string; text?: string }> }>;
}

interface GedcomxRecord {
  persons?: GedcomxPerson[];
  relationships?: Array<{
    type?: string;
    person1?: { resource?: string };
    person2?: { resource?: string };
    facts?: GedcomxFact[];
  }>;
  sourceDescriptions?: Array<{
    resourceType?: string;
    about?: string;
    titles?: Array<{ value?: string }>;
    citations?: Array<{ value?: string }>;
  }>;
}

function formatSummary(person?: PersonSummary): string {
  if (!person?.id) return 'Unknown';
  return `${person.name || 'Unknown'} (${person.fullLifespan || person.lifespan || '?'}) [${person.id}]`;
}

function formatMarriage(group: FamilyGroup): string {
  const date = group.event?.details?.date?.originalText || group.event?.details?.date?.normalizedText;
  const place = group.event?.details?.place?.originalText || group.event?.details?.place?.normalizedText;
  if (!date && !place) return '';
  return ` — married ${[date, place].filter(Boolean).join(', ')}`;
}

function personName(person: GedcomxPerson): string {
  return person.names?.[0]?.nameForms?.[0]?.fullText || 'Unknown';
}

function gedcomxType(uri?: string): string | undefined {
  return uri?.split('/').pop();
}

function resourceId(ref?: { resource?: string }): string {
  return ref?.resource?.replace(/^.*#/, '') || '';
}

function formatFact(fact: GedcomxFact): string {
  const type = gedcomxType(fact.type) || 'Fact';
  const parts = [fact.value, fact.date?.original, fact.place?.original].filter(Boolean);
  return `${type}: ${parts.join(', ') || '?'}`;
}

function formatFacts(person: GedcomxPerson): string {
  return (person.facts || []).map(formatFact).join('; ');
}

// Record fields carry extras such as age, occupation or residence that are not modelled as facts.
function formatFields(fields: GedcomxPerson['fields']): string {
  return (fields || [])
    .filter((field) => !field.type?.includes('SortKey'))
    .map((field) => {
      const type = gedcomxType(field.type) || 'Field';
      const text = field.values?.find((v) => v.type?.endsWith('Interpreted'))?.text || field.values?.[0]?.text;
      return text ? `${type}: ${text}` : '';
    })
    .filter(Boolean)
    .join('; ');
}

export interface RecordSearchParams {
  givenName?: string;
  surname?: string;
  exactSurname?: boolean;
  gender?: 'MALE' | 'FEMALE';
  birthDate?: string;
  birthYearFrom?: string;
  birthYearTo?: string;
  birthPlace?: string;
  deathDate?: string;
  deathYearFrom?: string;
  deathYearTo?: string;
  deathPlace?: string;
  marriageYearFrom?: string;
  marriageYearTo?: string;
  marriagePlace?: string;
  residencePlace?: string;
  anyPlace?: string;
  spouseGivenName?: string;
  spouseSurname?: string;
  fatherGivenName?: string;
  fatherSurname?: string;
  motherGivenName?: string;
  motherSurname?: string;
  recordCountry?: string;
  collectionId?: string;
  limit?: number;
  offset?: number;
}

type StringSearchParam = Exclude<keyof RecordSearchParams, 'exactSurname' | 'gender' | 'birthDate' | 'deathDate' | 'limit' | 'offset'>;

const RECORD_SEARCH_PARAMS: ReadonlyArray<[StringSearchParam, string]> = [
  ['givenName', 'q.givenName'],
  ['surname', 'q.surname'],
  ['birthYearFrom', 'q.birthLikeDate.from'],
  ['birthYearTo', 'q.birthLikeDate.to'],
  ['birthPlace', 'q.birthLikePlace'],
  ['deathYearFrom', 'q.deathLikeDate.from'],
  ['deathYearTo', 'q.deathLikeDate.to'],
  ['deathPlace', 'q.deathLikePlace'],
  ['marriageYearFrom', 'q.marriageLikeDate.from'],
  ['marriageYearTo', 'q.marriageLikeDate.to'],
  ['marriagePlace', 'q.marriageLikePlace'],
  ['residencePlace', 'q.residencePlace'],
  ['anyPlace', 'q.anyPlace'],
  ['spouseGivenName', 'q.spouseGivenName'],
  ['spouseSurname', 'q.spouseSurname'],
  ['fatherGivenName', 'q.fatherGivenName'],
  ['fatherSurname', 'q.fatherSurname'],
  ['motherGivenName', 'q.motherGivenName'],
  ['motherSurname', 'q.motherSurname'],
  ['recordCountry', 'f.recordCountry'],
  ['collectionId', 'f.collectionId'],
];

function describeRelatives(record: GedcomxRecord, principal: GedcomxPerson): string[] {
  const byId = new Map((record.persons || []).map((p) => [p.id || '', p]));
  const self = principal.id || '';
  return (record.relationships || []).flatMap((rel) => {
    const p1 = resourceId(rel.person1);
    const p2 = resourceId(rel.person2);
    if (p1 !== self && p2 !== self) return [];
    const other = byId.get(p1 === self ? p2 : p1);
    if (!other) return [];
    const role = rel.type?.endsWith('Couple') ? 'Spouse' : rel.type?.endsWith('ParentChild') ? (p2 === self ? 'Parent' : 'Child') : 'Related';
    return [`${role}: ${personName(other)}`];
  });
}

function collectionTitle(record?: GedcomxRecord): string | undefined {
  return record?.sourceDescriptions?.find((sd) => sd.resourceType === 'http://gedcomx.org/Collection')?.titles?.[0]?.value;
}

export function extractCookieValue(cookieHeader: string, name: string): string {
  return cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))?.[1] || '';
}

function buildCookieHeader(sessionId?: string, fsAnid?: string): string {
  const parts: string[] = [];
  if (sessionId) parts.push(`fssessionid=${sessionId}`);
  if (fsAnid) parts.push(`fs_anid=${fsAnid}`);
  return parts.join('; ');
}
