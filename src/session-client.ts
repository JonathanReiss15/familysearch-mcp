import type { GxAtomFeed, GxDocument } from './gedcomx.js';

const BASE_URL = 'https://www.familysearch.org';

// Media types for the official /platform API. JSON for /service endpoints.
const FS_JSON = 'application/x-fs-v1+json';
const ATOM_JSON = 'application/x-gedcomx-atom+json';

// Space requests out so bursts (e.g. walking a large tree) don't trip
// FamilySearch's bot protection.
const MIN_REQUEST_INTERVAL_MS = 250;

export class FamilySearchSessionError extends Error {
  constructor(message: string, public statusCode?: number) {
    super(message);
    this.name = 'FamilySearchSessionError';
  }
}

export interface SessionClientOptions {
  sessionId?: string;
  fsAnid?: string;
  cookies?: string;
}

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36';

type QueryParams = Record<string, string | number | boolean | undefined>;

interface SearchEntry {
  id?: string;
  title?: string;
  content?: {
    gedcomx?: {
      description?: string;
      sourceDescriptions?: Array<{ resourceType?: string; titles?: Array<{ value?: string }> }>;
      persons?: Array<{
        id?: string;
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
}

function summarizeFact(fact?: { date?: { original?: string }; place?: { original?: string } }): string {
  return fact ? `${fact.date?.original || 'Unknown date'} - ${fact.place?.original || 'Unknown place'}` : 'Unknown';
}

/** Accepts "M67N-1Z7", "1:1:M67N-1Z7", or a full ark URL and returns "M67N-1Z7". */
export function normalizeRecordId(value: string): string {
  return value.trim().match(/1:1:([A-Z0-9-]+)/i)?.[1] || value.trim();
}

export class FamilySearchSessionClient {
  private cookies: string;
  private sessionId: string;
  private lastRequest: Promise<void> = Promise.resolve();
  private collectionsCache?: Promise<CollectionSummary[]>;

  constructor(options: SessionClientOptions) {
    this.cookies = options.cookies || buildCookieHeader(options.sessionId, options.fsAnid);
    this.sessionId = options.sessionId || extractCookie(this.cookies, 'fssessionid');
  }

  isAuthenticated(): boolean {
    return Boolean(this.cookies);
  }

  setSession(sessionId: string, fsAnid?: string, cookies?: string): void {
    this.cookies = cookies || buildCookieHeader(sessionId, fsAnid);
    this.sessionId = sessionId || extractCookie(this.cookies, 'fssessionid');
  }

  private async throttle(): Promise<void> {
    const previous = this.lastRequest;
    let release!: () => void;
    this.lastRequest = new Promise((resolve) => (release = resolve));
    await previous;
    setTimeout(release, MIN_REQUEST_INTERVAL_MS);
  }

  private async request<T>(path: string, params?: QueryParams, accept = 'application/json'): Promise<T> {
    if (!this.cookies) {
      throw new FamilySearchSessionError('Not authenticated. Set a browser session cookie first.');
    }

    const url = new URL(path.startsWith('http') ? path : `${BASE_URL}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '') {
          url.searchParams.set(key, String(value));
        }
      }
    }

    await this.throttle();
    const response = await fetch(url, {
      headers: {
        Accept: accept,
        // Node's fetch defaults to "*", which makes FamilySearch return empty
        // localized strings (e.g. relationship descriptions).
        'Accept-Language': 'en',
        // /platform and profile endpoints authenticate with the session as a
        // bearer token; /service/tree endpoints accept the cookie alone.
        ...(this.sessionId ? { Authorization: `Bearer ${this.sessionId}` } : {}),
        Cookie: this.cookies,
        Referer: 'https://www.familysearch.org/en/',
        'User-Agent': BROWSER_USER_AGENT,
      },
    });

    const text = await response.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      if (response.status === 401 || response.status === 403) {
        throw sessionExpiredError(response.status);
      }
      throw new FamilySearchSessionError(
        `Invalid JSON response (${response.status}) from ${path}: ${text.slice(0, 200)}`,
        response.status,
      );
    }

    if (response.status === 401) {
      throw sessionExpiredError(401);
    }

    if (!response.ok) {
      throw new FamilySearchSessionError(
        `Request failed with status ${response.status}: ${errorDetail(data) || path}`,
        response.status,
      );
    }

    if (
      typeof data === 'object' &&
      data !== null &&
      'status' in data &&
      (data as { status?: string }).status === 'UNAUTHORIZED'
    ) {
      throw sessionExpiredError(401);
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

  /**
   * Confirms the session belongs to a signed-in user. FamilySearch also issues
   * session cookies to anonymous visitors (and lets them search), so this must
   * hit an endpoint that rejects anonymous sessions.
   */
  async validateSession(): Promise<{ displayName: string; personId: string }> {
    const start = await this.request<{ personId?: string }>('/service/tree/tree-data/user/CURRENT/starting-person-id');
    const user = await this.getPlatformUser().catch(() => undefined);
    return {
      displayName: user?.displayName || user?.contactName || 'FamilySearch user',
      personId: start.personId || user?.personId || '',
    };
  }

  private async getPlatformUser() {
    const data = await this.request<{
      users?: Array<{ displayName?: string; contactName?: string; personId?: string; treeUserId?: string; id?: string }>;
    }>('/platform/users/current', undefined, FS_JSON);
    return data.users?.[0];
  }

  async getCurrentUser() {
    const [user, profile] = await Promise.all([
      this.getPlatformUser(),
      this.request<{ contactInfo?: { methods?: Array<{ method?: string; value?: string }> } }>(
        '/service/user/profile/users/CURRENT',
      ),
    ]);
    return {
      displayName: user?.displayName || 'Unknown',
      fullName: user?.contactName || 'Unknown',
      personId: user?.personId || '',
      email: profile.contactInfo?.methods?.find((m) => m.method === 'EMAIL')?.value || 'Unknown',
      accountId: user?.id || '',
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

    const data = await this.request<{ entries?: SearchEntry[] }>('/service/search/tree/v2/personas', query);

    return (data.entries || []).map((entry) => {
      const person = entry.content?.gedcomx?.persons?.[0];
      return {
        id: entry.id || 'Unknown',
        name: person?.names?.[0]?.nameForms?.[0]?.fullText || entry.title || 'Unknown',
        gender: person?.gender?.type?.replace('http://gedcomx.org/', '') || 'Unknown',
        birth: summarizeFact(person?.facts?.find((fact) => fact.type === 'http://gedcomx.org/Birth')),
        death: summarizeFact(person?.facts?.find((fact) => fact.type === 'http://gedcomx.org/Death')),
      };
    });
  }

  /** Person with facts plus parents, siblings, spouses, and children in one document. */
  async getPersonWithFamily(personId: string): Promise<GxDocument> {
    return this.request<GxDocument>(`/platform/tree/persons/${personId}/families`, undefined, FS_JSON);
  }

  async getAncestry(personId: string, generations: number): Promise<GxDocument> {
    return this.request<GxDocument>(
      '/platform/tree/ancestry',
      { person: personId, generations: clamp(generations, 1, 8) },
      FS_JSON,
    );
  }

  async getDescendancy(personId: string, generations: number): Promise<GxDocument> {
    return this.request<GxDocument>(
      '/platform/tree/descendancy',
      { person: personId, generations: clamp(generations, 1, 4) },
      FS_JSON,
    );
  }

  async getSources(personId: string): Promise<GxDocument> {
    return this.request<GxDocument>(`/platform/tree/persons/${personId}/sources`, undefined, FS_JSON);
  }

  async getMemories(personId: string): Promise<GxDocument> {
    return this.request<GxDocument>(`/platform/tree/persons/${personId}/memories`, undefined, FS_JSON);
  }

  async getNotes(personId: string): Promise<GxDocument> {
    return this.request<GxDocument>(`/platform/tree/persons/${personId}/notes`, undefined, FS_JSON);
  }

  async getChanges(personId: string): Promise<GxAtomFeed> {
    return this.request<GxAtomFeed>(`/platform/tree/persons/${personId}/changes`, undefined, ATOM_JSON);
  }

  async getRecord(recordId: string): Promise<GxDocument> {
    return this.request<GxDocument>(`/platform/records/personas/${normalizeRecordId(recordId)}`, undefined, FS_JSON);
  }

  async getRelationshipToMe(personId: string) {
    const data = await this.request<{
      relationshipDescription?: string;
      generations?: Array<Record<string, RelationshipPathStep | undefined>>;
    }>(`/service/tree/tree-data/user-relationship/v2/person/${personId}`);

    // Each generation has ascending/descending sides and possibly an apex
    // (common ancestor); indexInPath orders the steps from you to the target.
    const steps = (data.generations || [])
      .flatMap((generation) => [generation.ascendingSide, generation.apex, generation.descendingSide])
      .filter((step): step is RelationshipPathStep => Boolean(step?.person))
      .sort((a, b) => (a.indexInPath ?? 0) - (b.indexInPath ?? 0))
      .map((step) => ({
        relation: step.person?.relationshipToPreviousDescription || '',
        name: step.person?.nameConclusion?.details?.fullText || 'Unknown',
        id: step.person?.id || '',
        lifespan: step.person?.lifespan || '',
        commonAncestor: Boolean(step.person?.commonAncestor),
      }));

    return { description: data.relationshipDescription || '', steps };
  }

  async getRecordHints(personId: string) {
    const data = await this.request<{
      matches?: Array<{
        personName?: string;
        collectionTitle?: string;
        recordUrl?: string;
        score?: number;
        confidence?: number;
        events?: Array<{ type?: string; date?: string; place?: string }>;
        relations?: Array<{ name?: string; type?: string }>;
      }>;
    }>(`/service/tree/tree-data/v8/record-matches/${personId}`);
    return data.matches || [];
  }

  async getDataQuality(personId: string) {
    const fetchScores = () =>
      this.request<{
        personScores?: {
          overallDisplayScore?: number;
          completenessScore?: { displayScore?: number };
          consistencyScore?: { displayScore?: number };
          coherenceScore?: { displayScore?: number };
          verifiabilityScore?: { displayScore?: number };
          issues?: QualityIssue[];
        };
      }>(`/service/tree/tree-data/quality/person/${personId}/scores`, { limitScope: false });

    // Scores are computed on demand; the first request may return before
    // they're ready, so give the calculation a moment and retry once.
    let data = await fetchScores();
    if (!data.personScores) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      data = await fetchScores();
    }
    return data.personScores;
  }

  async searchRecords(params: {
    givenName?: string;
    surname?: string;
    birthDate?: string;
    birthPlace?: string;
    deathDate?: string;
    deathPlace?: string;
    marriageDate?: string;
    marriagePlace?: string;
    residencePlace?: string;
    spouseGivenName?: string;
    spouseSurname?: string;
    fatherGivenName?: string;
    fatherSurname?: string;
    motherGivenName?: string;
    motherSurname?: string;
    collectionId?: string;
    limit?: number;
    offset?: number;
  }) {
    const query: Record<string, string | number> = {
      count: params.limit || 10,
      offset: params.offset || 0,
      'm.defaultFacets': 'on',
      'm.facetNestCollectionInCategory': 'on',
      'm.queryRequireDefault': 'on',
    };

    const mapping: Array<[keyof typeof params, string]> = [
      ['givenName', 'q.givenName'],
      ['surname', 'q.surname'],
      ['birthDate', 'q.birthLikeDate.from'],
      ['birthPlace', 'q.birthLikePlace'],
      ['deathDate', 'q.deathLikeDate.from'],
      ['deathPlace', 'q.deathLikePlace'],
      ['marriageDate', 'q.marriageLikeDate.from'],
      ['marriagePlace', 'q.marriageLikePlace'],
      ['residencePlace', 'q.residencePlace'],
      ['spouseGivenName', 'q.spouseGivenName'],
      ['spouseSurname', 'q.spouseSurname'],
      ['fatherGivenName', 'q.fatherGivenName'],
      ['fatherSurname', 'q.fatherSurname'],
      ['motherGivenName', 'q.motherGivenName'],
      ['motherSurname', 'q.motherSurname'],
      ['collectionId', 'f.collectionId'],
    ];
    for (const [param, key] of mapping) {
      const value = params[param];
      if (value !== undefined && value !== '') query[key] = value;
    }

    const data = await this.request<{ results?: number; entries?: SearchEntry[] }>(
      '/service/search/hr/v2/personas',
      query,
    );

    const records = (data.entries || []).map((record) => {
      const gedcomx = record.content?.gedcomx;
      // description ("#src_p_p_123") names the matched persona, who may be a
      // parent or spouse on someone else's record rather than persons[0].
      const matchedId = typeof gedcomx?.description === 'string' ? gedcomx.description.replace(/^#src_p_/, '') : '';
      const person = gedcomx?.persons?.find((p) => p.id === matchedId) || gedcomx?.persons?.[0];
      const title = (type: string) =>
        gedcomx?.sourceDescriptions?.find((s) => s.resourceType?.endsWith(`/${type}`))?.titles?.[0]?.value;
      return {
        id: record.id || 'Unknown',
        name: person?.names?.[0]?.nameForms?.[0]?.fullText || record.title || 'Unknown',
        gender: person?.gender?.type?.replace('http://gedcomx.org/', '') || 'Unknown',
        birth: summarizeFact(person?.facts?.find((fact) => fact.type === 'http://gedcomx.org/Birth')),
        death: summarizeFact(person?.facts?.find((fact) => fact.type === 'http://gedcomx.org/Death')),
        record: title('Record') || 'Unknown record',
        collection: title('Collection') || 'Unknown collection',
      };
    });
    return { total: data.results || 0, records };
  }

  async searchFullText(params: { text: string; collectionId?: string; limit?: number; offset?: number }) {
    const data = await this.request<{
      results?: number;
      entries?: Array<{
        id?: string;
        sourceUrl?: string;
        collectionTitle?: string;
        content?: {
          title?: string;
          recordType?: string;
          recordDate?: string;
          recordPlace?: string;
          textDocument?: string;
          highlightTexts?: string[];
        };
      }>;
    }>('/service/search/fulltext/search', {
      'q.text': params.text,
      'f.collectionId': params.collectionId,
      count: params.limit || 10,
      offset: params.offset || 0,
    });

    const documents = (data.entries || []).map((entry) => ({
      id: entry.id || '',
      title: entry.content?.title || 'Untitled document',
      collection: entry.collectionTitle || 'Unknown collection',
      url: entry.sourceUrl || '',
      excerpt: excerpt(entry.content?.textDocument || '', entry.content?.highlightTexts || []),
    }));
    return { total: data.results || 0, documents };
  }

  /** All searchable record collections, fetched once per server session (~3 MB). */
  private loadCollections(): Promise<CollectionSummary[]> {
    this.collectionsCache ??= this.request<{
      entries?: Array<{
        content?: {
          gedcomx?: {
            collections?: Array<{
              id?: string;
              title?: string;
              searchMetadata?: Array<{ recordCount?: number; imageCount?: number; startYear?: number; endYear?: number; region?: string }>;
            }>;
          };
        };
      }>;
    }>('/service/search/hr/v2/collections', { count: 5000, offset: 0 })
      .then((data) =>
        (data.entries || []).map((entry) => {
          const collection = entry.content?.gedcomx?.collections?.[0];
          const meta = collection?.searchMetadata?.[0];
          return {
            id: collection?.id || '',
            title: collection?.title || 'Untitled collection',
            recordCount: meta?.recordCount || 0,
            imageCount: meta?.imageCount || 0,
            startYear: meta?.startYear,
            endYear: meta?.endYear,
            region: meta?.region || '',
          };
        }),
      )
      .catch((error) => {
        this.collectionsCache = undefined;
        throw error;
      });
    return this.collectionsCache;
  }

  async searchCollections(params: { query?: string; year?: number; limit?: number }) {
    // Match at word starts so "kansas" doesn't match "Arkansas" but "marriage" matches "Marriages".
    const patterns = (params.query || '')
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => new RegExp(`(^|[^\\p{L}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'iu'));
    const matches = (await this.loadCollections()).filter((collection) => {
      const haystack = `${collection.title} ${collection.region.replace(/_/g, ' ')}`;
      const inYears =
        params.year === undefined ||
        ((collection.startYear ?? -Infinity) <= params.year && params.year <= (collection.endYear ?? Infinity));
      return inYears && patterns.every((pattern) => pattern.test(haystack));
    });
    matches.sort((a, b) => b.recordCount - a.recordCount);
    return { total: matches.length, collections: matches.slice(0, params.limit || 20) };
  }

  async searchCatalog(params: { keywords: string; limit?: number; offset?: number }) {
    const data = await this.request<{
      totalHits?: number;
      searchHits?: Array<{
        metadataHit?: {
          metadata?: {
            title?: Array<{ value?: string }>;
            creator?: string[];
            identifier?: { value?: string };
            repositoryCalls?: Array<{ title?: string }>;
          };
        };
      }>;
    }>('/service/search/catalog/v3/search', {
      'q.keywords': params.keywords,
      count: params.limit || 10,
      offset: params.offset || 0,
    });

    const items = (data.searchHits || []).map((hit) => {
      const metadata = hit.metadataHit?.metadata;
      // The site links to /search/catalog/<last path segment>, prefix (e.g. "olib:") included.
      const id = metadata?.identifier?.value?.match(/\/([^/]*)$/)?.[1];
      return {
        title: metadata?.title?.[0]?.value || 'Untitled',
        creators: metadata?.creator || [],
        url: id ? `https://www.familysearch.org/search/catalog/${id}` : '',
        repositories: [...new Set((metadata?.repositoryCalls || []).map((r) => r.title).filter(Boolean))] as string[],
      };
    });
    return { total: data.totalHits || 0, items };
  }

  async searchPlaces(name: string, limit = 10) {
    const data = await this.request<{
      entries?: Array<{
        score?: number;
        content?: {
          gedcomx?: {
            places?: Array<{
              id?: string;
              latitude?: number;
              longitude?: number;
              display?: { fullName?: string; type?: string };
              temporalDescription?: { formal?: string };
            }>;
          };
        };
      }>;
    }>('/platform/places/search', { q: `name:"${name.replace(/"/g, '')}"`, count: limit }, ATOM_JSON);

    return (data.entries || []).map((entry) => {
      const place = entry.content?.gedcomx?.places?.[0];
      return {
        id: place?.id || '',
        name: place?.display?.fullName || 'Unknown',
        type: place?.display?.type || '',
        existed: place?.temporalDescription?.formal?.replace(/\+/g, '') || '',
        coordinates: place?.latitude !== undefined ? `${place.latitude}, ${place.longitude}` : '',
        score: entry.score,
      };
    });
  }

  async interpretDate(text: string) {
    const data = await this.request<{
      dates?: Array<{
        original?: string;
        gedcomx?: string;
        localizedDate?: { value?: string };
        detail?: { simpleDates?: Array<{ isApproximate?: boolean; precision?: string }> };
      }>;
    }>('/service/standards/date/ws/dates/interp', { text });

    return (data.dates || []).map((date) => ({
      original: date.original || text,
      standard: date.localizedDate?.value || 'Unrecognized',
      formal: date.gedcomx || '',
      approximate: Boolean(date.detail?.simpleDates?.some((d) => d.isApproximate)),
      precision: date.detail?.simpleDates?.[0]?.precision || '',
    }));
  }
}

interface RelationshipPathStep {
  indexInPath?: number;
  person?: {
    id?: string;
    lifespan?: string;
    commonAncestor?: boolean;
    relationshipToPreviousDescription?: string;
    nameConclusion?: { details?: { fullText?: string } };
  };
}

export interface QualityIssue {
  issueType?: string;
  scoreType?: string;
  conclusionType?: string;
  conclusionName?: string;
  conclusionOriginalDate?: string;
  sourceName?: string;
  sourceOriginalDate?: string;
  sourceTitle?: string;
}

export interface CollectionSummary {
  id: string;
  title: string;
  recordCount: number;
  imageCount: number;
  startYear?: number;
  endYear?: number;
  region: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.trunc(value) || min, min), max);
}

function sessionExpiredError(status: number): FamilySearchSessionError {
  return new FamilySearchSessionError(
    'FamilySearch session is not signed in or has expired. Run login-with-browser to sign in again.',
    status,
  );
}

function errorDetail(data: unknown): string {
  if (typeof data !== 'object' || data === null) return '';
  const record = data as { message?: string; detail?: string; error?: string; errors?: Array<{ message?: string }> };
  return record.message || record.detail || record.errors?.[0]?.message || record.error || '';
}

/** ~300 characters of document text around the first highlighted term. */
function excerpt(text: string, highlights: string[]): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  const lower = clean.toLowerCase();
  const hit = highlights.map((h) => lower.indexOf(h.toLowerCase())).find((index) => index >= 0) ?? 0;
  const start = Math.max(hit - 150, 0);
  return `${start > 0 ? '…' : ''}${clean.slice(start, start + 300)}${start + 300 < clean.length ? '…' : ''}`;
}

function extractCookie(cookieHeader: string, name: string): string {
  return cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))?.[1] || '';
}

function buildCookieHeader(sessionId?: string, fsAnid?: string): string {
  const parts: string[] = [];
  if (sessionId) parts.push(`fssessionid=${sessionId}`);
  if (fsAnid) parts.push(`fs_anid=${fsAnid}`);
  return parts.join('; ');
}
