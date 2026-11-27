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

  constructor(options: SessionClientOptions) {
    this.cookies = options.cookies || buildCookieHeader(options.sessionId, options.fsAnid);
  }

  isAuthenticated(): boolean {
    return Boolean(this.cookies);
  }

  setSession(sessionId: string, fsAnid?: string, cookies?: string): void {
    this.cookies = cookies || buildCookieHeader(sessionId, fsAnid);
  }

  private cookieHeader(): string {
    return this.cookies;
  }

  private ensureAuthenticated(): void {
    if (!this.cookies) {
      throw new FamilySearchSessionError('Not authenticated. Set a browser session cookie first.');
    }
  }

  private headers(accept: string): Record<string, string> {
    return {
      Accept: accept,
      Cookie: this.cookieHeader(),
      Referer: 'https://www.familysearch.org/en/',
      'User-Agent': BROWSER_USER_AGENT,
    };
  }

  private async request<T>(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<T> {
    this.ensureAuthenticated();

    const url = new URL(path.startsWith('http') ? path : `${BASE_URL}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '') {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const response = await fetch(url, { headers: this.headers('application/json') });
    return this.parseJson<T>(response, path);
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    this.ensureAuthenticated();

    const response = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        ...this.headers('application/json'),
        'Content-Type': 'application/json',
        Origin: BASE_URL,
      },
      body: JSON.stringify(body),
    });
    return this.parseJson<T>(response, path);
  }

  private async parseJson<T>(response: Response, path: string): Promise<T> {
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
      parents?: Array<{
        parent1?: PersonSummary;
        parent2?: PersonSummary;
        children?: PersonSummary[];
      }>;
      spouses?: Array<{
        spouse1?: PersonSummary;
        spouse2?: PersonSummary;
        children?: PersonSummary[];
        event?: { details?: { date?: { original?: string }; place?: { localizedText?: string } } };
      }>;
    }>(`/service/tree/tree-data/r9/family-members/person/${personId}`, {
      includePhotos: true,
      treeId: 'PRIVATE',
    });
  }

  async getAncestors(personId: string, generations = 4) {
    const gens = Math.min(Math.max(generations, 1), 8);
    const data = await this.request<{ ancestors?: AncestorGeneration[][] }>(
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

      for (const spouseGroup of family.spouses || []) {
        for (const child of spouseGroup.children || []) {
          if (child.id) children.set(child.id, child);
        }
      }

      for (const parentGroup of family.parents || []) {
        for (const child of parentGroup.children || []) {
          if (child.id && child.id !== currentId) children.set(child.id, child);
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

  async searchRecords(params: {
    givenName?: string;
    surname?: string;
    birthDate?: string;
    birthPlace?: string;
    deathDate?: string;
    deathPlace?: string;
    collectionId?: string;
    limit?: number;
  }) {
    const query: Record<string, string | number> = {
      count: params.limit || 10,
      offset: 0,
      'm.defaultFacets': 'on',
      'm.facetNestCollectionInCategory': 'on',
      'm.queryRequireDefault': 'on',
    };

    if (params.givenName) query['q.givenName'] = params.givenName;
    if (params.surname) query['q.surname'] = params.surname;
    if (params.birthDate) query['q.birthLikeDate.from'] = params.birthDate;
    if (params.birthPlace) query['q.birthLikePlace'] = params.birthPlace;
    if (params.deathDate) query['q.deathLikeDate.from'] = params.deathDate;
    if (params.deathPlace) query['q.deathLikePlace'] = params.deathPlace;
    if (params.collectionId) query['f.collectionId'] = params.collectionId;

    const data = await this.request<{
      entries?: Array<{
        id?: string;
        title?: string;
        content?: {
          gedcomx?: {
            description?: { title?: string };
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
    }>('/service/search/hr/v2/personas', query);

    return (data.entries || []).map((record) => {
      const primaryPerson = record.content?.gedcomx?.persons?.[0];
      const birthFact = primaryPerson?.facts?.find((fact) => fact.type === 'http://gedcomx.org/Birth');
      const deathFact = primaryPerson?.facts?.find((fact) => fact.type === 'http://gedcomx.org/Death');

      return {
        id: record.id || 'Unknown',
        name: primaryPerson?.names?.[0]?.nameForms?.[0]?.fullText || record.title || 'Unknown',
        gender: primaryPerson?.gender?.type?.replace('http://gedcomx.org/', '') || 'Unknown',
        birth: birthFact
          ? `${birthFact.date?.original || 'Unknown date'} - ${birthFact.place?.original || 'Unknown place'}`
          : 'Unknown',
        death: deathFact
          ? `${deathFact.date?.original || 'Unknown date'} - ${deathFact.place?.original || 'Unknown place'}`
          : 'Unknown',
        collection: record.content?.gedcomx?.description?.title || 'Unknown collection',
      };
    });
  }

  /** Image ARKs of a digital film (DGS / image group number), in viewer order. */
  async getFilmImages(film: string): Promise<FilmImages> {
    const { dgsNum } = parseFilmRef(film);
    const cached = this.filmCache.get(dgsNum);
    if (cached) return cached;

    const data = await this.postJson<{
      dgsNum?: string;
      images?: string[];
      catalogs?: Array<{ data?: { display_title?: string; titleno?: string } }>;
    }>('/search/filmdatainfo/film-data', {
      type: 'film-data',
      loggedIn: true,
      sessionId: extractCookie(this.cookies, 'fssessionid'),
      args: {
        dgsNum,
        locale: 'en',
        state: { imageOrFilmUrl: `/search/film/${dgsNum}`, viewMode: 'i', selectedImageIndex: -1 },
      },
    });

    const arkIds = (data.images || []).map((url) => normalizeImageArk(url));
    if (!arkIds.length) {
      throw new FamilySearchSessionError(
        `Film ${dgsNum} has no images available to this account (not digitized, or restricted).`,
        404,
      );
    }

    const result: FilmImages = {
      dgsNum,
      arkIds,
      catalogs: (data.catalogs || []).map((catalog) => ({
        id: catalog.data?.titleno,
        title: catalog.data?.display_title || 'Untitled catalog entry',
      })),
    };
    this.filmCache.set(dgsNum, result);
    return result;
  }

  /** Film number and access rights of one image. */
  async getImageInfo(image: string): Promise<{ arkId: string; dgsNum?: string; rights?: ImageRights }> {
    const arkId = normalizeImageArk(image);
    const data = await this.postJson<{
      dgsNum?: string;
      meta?: { sourceDescriptions?: Array<{ rights?: string[] }> };
    }>('/search/filmdatainfo/image-data', {
      type: 'image-data',
      args: {
        imageURL: `${BASE_URL}/ark:/61903/${arkId}`,
        locale: 'en',
        state: { imageOrFilmUrl: '', selectedImageIndex: -1, viewMode: 'i' },
      },
    });

    return {
      arkId,
      dgsNum: data.dgsNum,
      rights: parseImageRights(data.meta?.sourceDescriptions?.[0]?.rights),
    };
  }

  /**
   * Resolves an image given either its ARK, or a film plus a 1-based image
   * number (the "Image N of M" the viewer shows).
   */
  async resolveImage(ref: { image?: string; film?: string; index?: number }): Promise<ResolvedImage> {
    if (ref.image) {
      const info = await this.getImageInfo(ref.image);
      const film = info.dgsNum ? await this.getFilmImages(info.dgsNum).catch(() => undefined) : undefined;
      const position = film ? film.arkIds.indexOf(info.arkId) : -1;
      return {
        ...info,
        index: position >= 0 ? position + 1 : undefined,
        total: film?.arkIds.length,
      };
    }

    if (ref.film) {
      const filmRef = parseFilmRef(ref.film);
      const index = ref.index ?? filmRef.index;
      if (!index) {
        throw new FamilySearchSessionError('Give index (the 1-based image number the viewer shows) together with film.');
      }
      const film = await this.getFilmImages(filmRef.dgsNum);
      if (index < 1 || index > film.arkIds.length) {
        throw new FamilySearchSessionError(
          `Film ${film.dgsNum} has ${film.arkIds.length} images; image ${index} is out of range.`,
        );
      }
      const arkId = film.arkIds[index - 1];
      const info = await this.getImageInfo(arkId);
      return { arkId, dgsNum: film.dgsNum, index, total: film.arkIds.length, rights: info.rights };
    }

    throw new FamilySearchSessionError('Provide image (an image ARK or viewer URL), or film plus index.');
  }

  /** Full-resolution JPEG, or a scaled one when width is given. */
  async fetchImage(arkId: string, width?: number): Promise<Buffer> {
    this.ensureAuthenticated();

    const variant = width ? `scale?width=${width}` : '$dist';
    const response = await fetch(`${BASE_URL}/service/records/storage/deepzoomcloud/dz/v1/${arkId}/${variant}`, {
      headers: this.headers('image/jpeg,image/*;q=0.9,*/*;q=0.5'),
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') || '';

    if (response.ok && contentType.startsWith('image/') && buffer[0] === 0xff && buffer[1] === 0xd8) {
      return buffer;
    }

    const textual = contentType.includes('json') || contentType.startsWith('text');
    const detail = textual
      ? buffer.toString('utf8', 0, 200).replace(/\s+/g, ' ')
      : `${buffer.length} bytes of ${contentType || 'unknown type'}`;
    if (response.status === 401) {
      throw new FamilySearchSessionError('Session expired. Run login-with-browser again.', 401);
    }
    if (/error\s*15|incapsula|blocked by our security/i.test(detail)) {
      throw new FamilySearchSessionError(
        'Image request blocked by FamilySearch security (error 15). Re-run login-with-browser to refresh cookies.',
        403,
      );
    }
    throw new FamilySearchSessionError(`Image ${arkId} could not be fetched (${response.status}): ${detail}`, response.status);
  }

  private filmCache = new Map<string, FilmImages>();
}

export interface ImageRights {
  restricted: boolean;
  allowDownload: boolean;
  authorized: boolean;
}

export interface FilmImages {
  dgsNum: string;
  arkIds: string[];
  catalogs: Array<{ id?: string; title: string }>;
}

export interface ResolvedImage {
  arkId: string;
  dgsNum?: string;
  /** 1-based position in the film, as the viewer numbers images. */
  index?: number;
  total?: number;
  rights?: ImageRights;
}

/** Accepts an image ARK (3:1:…), an ark:/61903/3:1:… path, or a viewer / image.xml URL. */
export function normalizeImageArk(input: string): string {
  const value = input.trim();
  const match = value.match(/3:1:([A-Z0-9]+(?:-[A-Z0-9]+)+)/i);
  if (match) return `3:1:${match[1].toUpperCase()}`;
  if (/^[A-Z0-9]+(?:-[A-Z0-9]+)+$/i.test(value)) return `3:1:${value.toUpperCase()}`;
  if (/[0-9]:[0-9]:[A-Z0-9]/i.test(value)) {
    throw new FamilySearchSessionError(
      `${value} is not an image ARK (images start with 3:1:; 1:1: is an indexed record).`,
    );
  }
  throw new FamilySearchSessionError(`Could not read an image ARK from "${value}".`);
}

/**
 * Accepts a DGS / image group number, or a /search/film/… or
 * records/images…imageGroupNumbers=… URL. An i= query value (0-based in the
 * viewer URL) becomes the 1-based index.
 */
export function parseFilmRef(input: string): { dgsNum: string; index?: number } {
  const value = input.trim();
  const number =
    value.match(/\/search\/film\/(\d+)/)?.[1] ||
    value.match(/(?:imageGroupNumbers|dgsNum)=(\d+)/)?.[1] ||
    value.match(/^(?:dgs\s*)?(\d{6,9})$/i)?.[1];
  if (!number) {
    throw new FamilySearchSessionError(`Could not read a film (DGS) number from "${value}".`);
  }
  const i = value.match(/[?&]i=(\d+)/)?.[1];
  return { dgsNum: number.padStart(9, '0'), index: i !== undefined ? Number(i) + 1 : undefined };
}

export function parseImageRights(rights?: string[]): ImageRights | undefined {
  const accessControl = rights?.find((right) => right.includes('accessControl?'));
  if (!accessControl) return undefined;
  const params = new URL(accessControl).searchParams;
  return {
    restricted: params.get('restricted') === 'true',
    allowDownload: params.get('allowDownload') === 'true',
    authorized: params.get('authorized') === 'true',
  };
}

function extractCookie(cookieHeader: string, name: string): string {
  return cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))?.[1] || '';
}

interface PersonSummary {
  id?: string;
  name?: string;
  gender?: string;
  lifespan?: string;
  birth?: { date?: string; place?: string };
}

interface AncestorGeneration {
  parent1?: PersonSummary;
  parent2?: PersonSummary;
}

function buildCookieHeader(sessionId?: string, fsAnid?: string): string {
  const parts: string[] = [];
  if (sessionId) parts.push(`fssessionid=${sessionId}`);
  if (fsAnid) parts.push(`fs_anid=${fsAnid}`);
  return parts.join('; ');
}
