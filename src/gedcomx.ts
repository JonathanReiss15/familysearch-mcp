// Minimal GEDCOM X shapes returned by /platform endpoints, plus text formatters
// used by the MCP tools. Only the fields the tools read are typed.

export interface GxDate {
  original?: string;
  formal?: string;
  normalized?: Array<{ value?: string }>;
}

export interface GxPlace {
  original?: string;
  normalized?: Array<{ value?: string }>;
}

export interface GxFact {
  type?: string;
  date?: GxDate;
  place?: GxPlace;
  value?: string;
  primary?: boolean;
}

export interface GxName {
  type?: string;
  preferred?: boolean;
  nameForms?: Array<{ fullText?: string }>;
}

export interface GxField {
  type?: string;
  values?: Array<{ text?: string }>;
}

export interface GxResourceRef {
  resource?: string;
  resourceId?: string;
}

export interface GxFamilyDisplay {
  parent1?: GxResourceRef;
  parent2?: GxResourceRef;
  children?: GxResourceRef[];
}

export interface GxPersonDisplay {
  name?: string;
  gender?: string;
  lifespan?: string;
  birthDate?: string;
  birthPlace?: string;
  deathDate?: string;
  deathPlace?: string;
  ascendancyNumber?: string;
  descendancyNumber?: string;
  familiesAsParent?: GxFamilyDisplay[];
  familiesAsChild?: GxFamilyDisplay[];
}

export interface GxPerson {
  id?: string;
  living?: boolean;
  principal?: boolean;
  gender?: { type?: string };
  names?: GxName[];
  facts?: GxFact[];
  fields?: GxField[];
  display?: GxPersonDisplay;
  sources?: unknown[];
  notes?: Array<{ subject?: string; text?: string }>;
}

export interface GxRelationship {
  type?: string;
  person1?: GxResourceRef;
  person2?: GxResourceRef;
  facts?: GxFact[];
}

export interface GxSourceDescription {
  id?: string;
  about?: string;
  resourceType?: string;
  mediaType?: string;
  created?: number;
  titles?: Array<{ value?: string }>;
  descriptions?: Array<{ value?: string }>;
  citations?: Array<{ value?: string }>;
  coverage?: Array<{ temporal?: { original?: string }; spatial?: { original?: string } }>;
  artifactMetadata?: Array<{ filename?: string; qualifiers?: Array<{ name?: string }> }>;
}

export interface GxDocument {
  description?: string;
  persons?: GxPerson[];
  relationships?: GxRelationship[];
  sourceDescriptions?: GxSourceDescription[];
}

export interface GxAtomFeed {
  entries?: Array<{
    id?: string;
    title?: string;
    updated?: number;
    contributors?: Array<{ name?: string }>;
    content?: unknown;
  }>;
}

const typeName = (uri?: string) => (uri || '').replace(/^.*\//, '');

// "MarriageLikeDate" style type URIs read better as "Marriage Like Date".
const humanize = (value: string) => value.replace(/([a-z])([A-Z])/g, '$1 $2');

const stripHtml = (value: string) => value.replace(/<[^>]+>/g, '');

export function formatDate(timestamp?: number): string {
  return timestamp ? new Date(timestamp).toISOString().slice(0, 10) : 'Unknown date';
}

export function preferredName(person?: GxPerson): string {
  const name = person?.names?.find((n) => n.preferred) || person?.names?.[0];
  return person?.display?.name || name?.nameForms?.[0]?.fullText || 'Unknown';
}

export function formatFact(fact: GxFact): string {
  const date = fact.date?.normalized?.[0]?.value || fact.date?.original;
  const place = fact.place?.normalized?.[0]?.value || fact.place?.original;
  const parts = [date, place, fact.value].filter(Boolean);
  return `${humanize(typeName(fact.type))}: ${parts.join(' — ') || 'No details'}`;
}

function personLabel(person: GxPerson | undefined, id?: string): string {
  if (!person) return id ? `Unknown [${id}]` : 'Unknown';
  return `${preferredName(person)} (${person.display?.lifespan || '?'}) [${person.id}]`;
}

/** Person view built from /platform/tree/persons/{id}/families. */
export function formatPerson(doc: GxDocument, personId: string): string {
  const persons = new Map((doc.persons || []).map((p) => [p.id, p]));
  const person = persons.get(personId);
  if (!person) return `Person ${personId} not found.`;

  const lines = [`${preferredName(person)} [${personId}]`];
  lines.push(`Gender: ${person.display?.gender || typeName(person.gender?.type) || 'Unknown'}`);
  lines.push(`Lifespan: ${person.living ? 'Living' : person.display?.lifespan || 'Unknown'}`);

  const otherNames = (person.names || [])
    .map((n) => n.nameForms?.[0]?.fullText)
    .filter((n): n is string => Boolean(n) && n !== preferredName(person));
  if (otherNames.length) lines.push(`Other names: ${[...new Set(otherNames)].join('; ')}`);

  if (person.facts?.length) {
    lines.push('', 'Facts:');
    for (const fact of person.facts) lines.push(`  ${formatFact(fact)}`);
  }

  for (const family of person.display?.familiesAsChild || []) {
    lines.push('', 'Parents:');
    for (const parent of [family.parent1, family.parent2]) {
      if (parent?.resourceId) lines.push(`  ${personLabel(persons.get(parent.resourceId), parent.resourceId)}`);
    }
    const siblings = (family.children || []).filter((c) => c.resourceId !== personId);
    if (siblings.length) {
      lines.push('Siblings:');
      for (const sibling of siblings) lines.push(`  ${personLabel(persons.get(sibling.resourceId), sibling.resourceId)}`);
    }
  }

  for (const family of person.display?.familiesAsParent || []) {
    const spouse = [family.parent1, family.parent2].find((p) => p?.resourceId && p.resourceId !== personId);
    const couple = (doc.relationships || []).find(
      (r) =>
        typeName(r.type) === 'Couple' &&
        [r.person1?.resourceId, r.person2?.resourceId].includes(personId) &&
        [r.person1?.resourceId, r.person2?.resourceId].includes(spouse?.resourceId),
    );
    lines.push('', `Spouse: ${spouse?.resourceId ? personLabel(persons.get(spouse.resourceId), spouse.resourceId) : 'Unknown'}`);
    for (const fact of couple?.facts || []) lines.push(`  ${formatFact(fact)}`);
    if (family.children?.length) {
      lines.push('  Children:');
      for (const child of family.children) lines.push(`    ${personLabel(persons.get(child.resourceId), child.resourceId)}`);
    }
  }

  lines.push('', `Attached sources: ${person.sources?.length || 0} (use get-sources for details)`);
  return lines.join('\n');
}

export function formatPedigree(doc: GxDocument, kind: 'ancestry' | 'descendancy'): string {
  const persons = doc.persons || [];
  if (!persons.length) return 'No persons found.';
  return persons
    .map((p) => {
      const d = p.display || {};
      const number = kind === 'ancestry' ? d.ascendancyNumber : d.descendancyNumber;
      // Spouses carry an "-S" suffix (e.g. "1-S", "1.2-S1"); indent by generation depth.
      const depth =
        kind === 'ancestry'
          ? Math.floor(Math.log2(Math.max(Number.parseInt(number || '1', 10), 1)))
          : (number || '1').split('-')[0].split('.').length - 1;
      const role = number?.includes('-S') ? 'Spouse: ' : '';
      const events = [
        d.birthDate || d.birthPlace ? `b. ${[d.birthDate, d.birthPlace].filter(Boolean).join(', ')}` : '',
        d.deathDate || d.deathPlace ? `d. ${[d.deathDate, d.deathPlace].filter(Boolean).join(', ')}` : '',
      ].filter(Boolean);
      return `${'  '.repeat(depth)}${number || '?'} ${role}${d.name || 'Unknown'} (${d.lifespan || '?'}) [${p.id}]${events.length ? ` — ${events.join('; ')}` : ''}`;
    })
    .join('\n');
}

export function formatSources(doc: GxDocument): string {
  const sources = doc.sourceDescriptions || [];
  if (!sources.length) return 'No sources attached.';
  return sources
    .map((s, index) => {
      const recordId = s.about?.match(/ark:\/61903\/1:1:([A-Z0-9-]+)/)?.[1];
      const coverage = s.coverage?.[0];
      const lines = [`${index + 1}. ${s.titles?.[0]?.value || 'Untitled source'}`];
      if (coverage?.temporal?.original || coverage?.spatial?.original) {
        lines.push(`   Coverage: ${[coverage.temporal?.original?.replace(/\+/g, ''), coverage.spatial?.original].filter(Boolean).join(' — ')}`);
      }
      if (recordId) lines.push(`   Record ID: ${recordId} (use get-record)`);
      else if (s.about) lines.push(`   URL: ${s.about}`);
      if (s.citations?.[0]?.value) lines.push(`   Citation: ${stripHtml(s.citations[0].value)}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

/** Full historical record from /platform/records/personas/{id}. */
export function formatRecord(doc: GxDocument): string {
  const sources = doc.sourceDescriptions || [];
  const record = sources.find((s) => typeName(s.resourceType) === 'Record');
  const collection = sources.find((s) => typeName(s.resourceType) === 'Collection');
  const image = sources.find((s) => typeName(s.resourceType).startsWith('DigitalArtifact'));
  // description is "#sd_p_123" and points at the persona this record was requested for.
  const focusId = doc.description?.replace(/^#sd_/, '');
  const persons = new Map((doc.persons || []).map((p) => [p.id, p]));

  const lines = [record?.titles?.[0]?.value || 'Historical record'];
  if (collection?.titles?.[0]?.value) lines.push(`Collection: ${collection.titles[0].value}`);
  if (image?.about) lines.push(`Image: ${image.about}`);
  if (record?.citations?.[0]?.value) lines.push(`Citation: ${stripHtml(record.citations[0].value)}`);

  lines.push('', `People on this record (${persons.size}):`);
  for (const person of persons.values()) {
    const marker = person.id === focusId ? ' ← requested person' : '';
    const gender = typeName(person.gender?.type);
    lines.push(`- ${preferredName(person)}${gender ? ` (${gender})` : ''}${marker}`);
    for (const field of person.fields || []) {
      const label = typeName(field.type);
      if (['Age', 'RelationshipToHead'].includes(label) && field.values?.[0]?.text) {
        lines.push(`    ${humanize(label)}: ${field.values[0].text}`);
      }
    }
    for (const fact of person.facts || []) lines.push(`    ${formatFact(fact)}`);
  }

  const relationships = doc.relationships || [];
  if (relationships.length) {
    lines.push('', 'Relationships:');
    for (const r of relationships) {
      const p1 = preferredName(persons.get(r.person1?.resourceId?.replace(/^#/, '')));
      const p2 = preferredName(persons.get(r.person2?.resourceId?.replace(/^#/, '')));
      const facts = (r.facts || []).map(formatFact).join('; ');
      lines.push(`- ${humanize(typeName(r.type))}: ${p1} & ${p2}${facts ? ` (${facts})` : ''}`);
    }
  }
  return lines.join('\n');
}

export function formatMemories(doc: GxDocument): string {
  const memories = doc.sourceDescriptions || [];
  if (!memories.length) return 'No memories attached.';
  return memories
    .map((m, index) => {
      const qualifier = typeName(m.artifactMetadata?.[0]?.qualifiers?.[0]?.name);
      const kind = qualifier || m.mediaType || 'Memory';
      const title = m.titles?.[0]?.value || m.artifactMetadata?.[0]?.filename || 'Untitled';
      const lines = [`${index + 1}. [${kind}] ${title} (added ${formatDate(m.created)})`];
      if (m.descriptions?.[0]?.value) lines.push(`   ${m.descriptions[0].value}`);
      if (m.about) lines.push(`   URL: ${m.about}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

export function formatNotes(doc: GxDocument): string {
  const notes = doc.persons?.[0]?.notes || [];
  if (!notes.length) return 'No notes.';
  return notes.map((n, index) => `${index + 1}. ${n.subject || 'Untitled'}\n${n.text || ''}`).join('\n\n');
}

function findValue(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (key in value && typeof (value as Record<string, unknown>)[key] === 'string') {
    return (value as Record<string, string>)[key];
  }
  for (const child of Object.values(value)) {
    const found = findValue(child, key);
    if (found) return found;
  }
  return undefined;
}

export function formatChanges(feed: GxAtomFeed, limit: number): string {
  const entries = feed.entries || [];
  if (!entries.length) return 'No change history.';
  const shown = entries.slice(0, limit).map((e) => {
    const who = e.contributors?.map((c) => c.name).filter(Boolean).join(', ') || 'Unknown contributor';
    const reason = findValue(e.content, 'changeMessage');
    return `${formatDate(e.updated)} — ${e.title || 'Change'} — ${who}${reason ? `\n   Reason: ${reason}` : ''}`;
  });
  const more = entries.length > limit ? `\n\n(${entries.length - limit} older changes not shown)` : '';
  return `${entries.length} changes, newest first:\n\n${shown.join('\n')}${more}`;
}
