const NAMED_ENTITIES = Object.freeze({
  amp: '&',
  quot: '"',
  apos: "'",
  lt: '<',
  gt: '>',
  nbsp: ' ',
});
const PARAGRAPH_BOUNDARY_TAGS = new Set([
  'p', 'div', 'section', 'article', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]);

function decodeHtmlEntities(value) {
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/gi, (entity, code) => {
    if (code[0] !== '#') return NAMED_ENTITIES[code.toLowerCase()] ?? entity;
    const hexadecimal = code[1]?.toLowerCase() === 'x';
    const numeric = Number.parseInt(code.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    if (!Number.isInteger(numeric) || numeric < 0 || numeric > 0x10ffff) return entity;
    try {
      return String.fromCodePoint(numeric);
    } catch {
      return entity;
    }
  });
}

function htmlTagAt(value, start) {
  let cursor = start + 1;
  let closing = false;
  if (value[cursor] === '/') {
    closing = true;
    cursor += 1;
  }
  const nameStart = cursor;
  if (!/[A-Za-z]/.test(value[cursor] || '')) return null;
  cursor += 1;
  while (/[A-Za-z0-9:-]/.test(value[cursor] || '')) cursor += 1;
  const name = value.slice(nameStart, cursor).toLowerCase();
  if (!/[\s/>]/.test(value[cursor] || '')) return null;

  let quote = '';
  for (; cursor < value.length; cursor += 1) {
    const character = value[cursor];
    if (quote) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return { closing, end: cursor + 1, name };
    }
  }
  return null;
}

function stripHtmlTagsWithBoundaries(value) {
  let result = '';
  let cursor = 0;
  while (cursor < value.length) {
    const start = value.indexOf('<', cursor);
    if (start === -1) return result + value.slice(cursor);
    result += value.slice(cursor, start);
    const tag = htmlTagAt(value, start);
    if (!tag) {
      result += '<';
      cursor = start + 1;
      continue;
    }

    if (tag.name === 'br') result += '\n';
    else if (tag.closing && PARAGRAPH_BOUNDARY_TAGS.has(tag.name)) result += '\n\n';
    else if (tag.closing && (tag.name === 'li' || tag.name === 'ul' || tag.name === 'ol')) {
      result += '\n';
    }
    cursor = tag.end;
  }
  return result;
}

function cleanSteamDescription(value) {
  if (value === undefined || value === null) return '';
  const withoutActiveContent = String(value)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/\r\n?/g, '\n');
  const withBoundaries = stripHtmlTagsWithBoundaries(withoutActiveContent);

  return decodeHtmlEntities(withBoundaries)
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizedForComparison(value) {
  return cleanSteamDescription(value)
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('en-US');
}

function firstCleaned(...values) {
  for (const value of values) {
    const cleaned = cleanSteamDescription(value);
    if (cleaned) return cleaned;
  }
  return '';
}

function mergeLocalizedDescriptions({
  appid,
  english = {},
  schinese = {},
  previous = {},
  fallbackTranslations = {},
}) {
  const exactAppid = String(appid);
  const exactPrevious = previous?.steam_appid == null
    || String(previous.steam_appid) === exactAppid
    ? previous
    : {};
  const description_en = firstCleaned(
    english.short_description,
    english.detailed_description,
    exactPrevious?.description_en,
  );
  if (!description_en) {
    throw new Error(`Steam App ${exactAppid} is missing an English description`);
  }

  let description_zh = firstCleaned(
    schinese.short_description,
    schinese.detailed_description,
  );
  if (
    description_zh
    && normalizedForComparison(description_zh) === normalizedForComparison(description_en)
  ) {
    description_zh = '';
  }
  if (!description_zh) description_zh = firstCleaned(fallbackTranslations?.[exactAppid]);
  if (!description_zh) description_zh = firstCleaned(exactPrevious?.description_zh);
  if (!description_zh) {
    throw new Error(`Steam App ${exactAppid} is missing a Simplified Chinese description`);
  }

  return { description_en, description_zh };
}

module.exports = {
  cleanSteamDescription,
  mergeLocalizedDescriptions,
};
