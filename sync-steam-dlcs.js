/**
 * Repeatable, Steam-official RPG Maker MZ DLC inventory sync.
 *
 * Usage: node sync-steam-dlcs.js
 */

const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const vm = require('node:vm');

const { extractAppIds, isRpgMakerMzDlc } = require('./lib/steam-catalog');
const { mergeCatalog } = require('./lib/dlc-model');
const { cleanSteamDescription, mergeLocalizedDescriptions } = require('./lib/dlc-localization');

const RPG_MAKER_MZ_APPID = '1096900';
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_REQUEST_INTERVAL_MS = 900;
const DEFAULT_EDGE_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_OUTPUT_DIR = path.join(__dirname, 'data');
const CURATED_DATA_FILE = path.join(__dirname, 'js/data.js');
const DEFAULT_TRANSLATIONS_FILE = path.join(__dirname, 'data/description-translations.zh-CN.json');
const DEFAULT_USER_AGENT = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
  'AppleWebKit/537.36 (KHTML, like Gecko)',
  'Chrome/139.0.0.0 Safari/537.36',
].join(' ');
const CLI_USAGE = [
  'Usage: node sync-steam-dlcs.js [options]',
  '',
  'Options:',
  '  -h, --help  Show this help and exit.',
].join('\n');

function createRequestScheduler({
  minIntervalMs = DEFAULT_REQUEST_INTERVAL_MS,
  cooldownMs = DEFAULT_EDGE_COOLDOWN_MS,
  now = Date.now,
  sleep: sleepFn = sleep,
} = {}) {
  let nextRequestAt = 0;
  let cooldownUntil = 0;
  let requestSlotQueue = Promise.resolve();

  async function waitForSlot() {
    const previousSlot = requestSlotQueue;
    let releaseSlot;
    requestSlotQueue = new Promise(resolve => { releaseSlot = resolve; });
    await previousSlot;
    try {
      while (true) {
        const delay = Math.max(0, nextRequestAt - now(), cooldownUntil - now());
        if (delay === 0) break;
        await sleepFn(delay);
      }
      const startedAt = now();
      nextRequestAt = startedAt + minIntervalMs;
      return startedAt;
    } finally {
      releaseSlot();
    }
  }

  function observeStatus(statusCode) {
    if (statusCode === 403 || statusCode === 429) {
      cooldownUntil = Math.max(cooldownUntil, now() + cooldownMs);
    }
  }

  return { waitForSlot, observeStatus };
}

function catalogPageUrl(start, count = 100) {
  const url = new URL(
    `https://store.steampowered.com/dlc/${RPG_MAKER_MZ_APPID}/RPG_Maker_MZ/ajaxgetfilteredrecommendations/`,
  );
  url.searchParams.set('start', String(start));
  url.searchParams.set('count', String(count));
  url.searchParams.set('l', 'english');
  url.searchParams.set('cc', 'cn');
  return url.toString();
}

function appDetailsUrl(appid, language = 'english') {
  const url = new URL('https://store.steampowered.com/api/appdetails');
  url.searchParams.set('appids', String(appid));
  url.searchParams.set('cc', 'cn');
  url.searchParams.set('l', language);
  return url.toString();
}

function reviewSummaryUrl(appid) {
  const url = new URL(`https://store.steampowered.com/appreviews/${appid}`);
  url.searchParams.set('json', '1');
  url.searchParams.set('language', 'all');
  url.searchParams.set('purchase_type', 'all');
  url.searchParams.set('filter', 'all');
  url.searchParams.set('num_per_page', '0');
  return url.toString();
}

async function requestText(url, options = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    redirects = 0,
    requestScheduler,
    userAgent = DEFAULT_USER_AGENT,
  } = options;
  if (requestScheduler) await requestScheduler.waitForSlot();

  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      timeout: timeoutMs,
      headers: {
        Accept: 'application/json,text/html;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': userAgent,
        Cookie: 'birthtime=0; lastagecheckage=1-January-1970; mature_content=1',
      },
    }, response => {
      if (requestScheduler) requestScheduler.observeStatus(response.statusCode);
      if (
        response.statusCode >= 300
        && response.statusCode < 400
        && response.headers.location
        && redirects < 5
      ) {
        response.resume();
        resolve(requestText(new URL(response.headers.location, url).toString(), {
          ...options,
          redirects: redirects + 1,
        }));
        return;
      }

      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Steam request failed with HTTP ${response.statusCode}`));
          return;
        }
        resolve(body);
      });
    });

    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error(`Steam request timed out after ${timeoutMs}ms`)));
  });
}

async function requestJson(url, options) {
  const body = await requestText(url, options);
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(`Steam returned invalid JSON: ${error.message}`);
  }
}

function fetchCatalogPage(start, options = {}) {
  return requestJson(catalogPageUrl(start, options.count || 100), options);
}

function parseCatalogPage(response) {
  if (!response || (Number(response.success) !== 1 && response.success !== true)) {
    throw new Error('Steam catalog paginator did not report success');
  }
  const pageSize = Number(response.pagesize);
  const totalCount = Number(response.total_count);
  const start = Number(response.start);
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new Error('Steam catalog paginator has an invalid pagesize');
  }
  if (!Number.isInteger(totalCount) || totalCount < 0) {
    throw new Error('Steam catalog paginator has an invalid total_count');
  }
  if (!Number.isInteger(start) || start < 0 || typeof response.results_html !== 'string') {
    throw new Error('Steam catalog paginator has an invalid start or results_html');
  }
  return {
    appids: extractAppIds(response.results_html),
    start,
    pageSize,
    totalCount,
  };
}

async function discoverOfficialDlcs(fetchPage, { pageSize = 100 } = {}) {
  const appids = new Set();
  let start = 0;
  let declaredTotal;

  while (declaredTotal === undefined || start < declaredTotal) {
    const page = parseCatalogPage(await fetchPage(start, { count: pageSize }));
    if (page.start !== start) {
      throw new Error(`Steam catalog paginator returned start ${page.start}, expected ${start}`);
    }
    if (declaredTotal === undefined) declaredTotal = page.totalCount;
    else if (page.totalCount !== declaredTotal) {
      throw new Error('Steam catalog paginator total_count changed during discovery');
    }
    if (declaredTotal === 0) return [];

    const before = appids.size;
    page.appids.forEach(appid => appids.add(appid));
    if (page.appids.length === 0) {
      throw new Error('Steam catalog paginator returned an empty window before full coverage');
    }
    if (appids.size === before) {
      throw new Error('Steam catalog paginator returned no new App IDs before full coverage');
    }

    start += page.pageSize;
  }

  if (appids.size !== declaredTotal) {
    throw new Error(`Steam catalog coverage mismatch: discovered ${appids.size} of ${declaredTotal}`);
  }
  return [...appids];
}

async function fetchAppDetails(appid, options = {}) {
  const response = await requestJson(appDetailsUrl(appid, options.language || 'english'), options);
  const entry = response[String(appid)];
  if (!entry?.success || !entry.data) throw new Error('Steam app details unavailable');
  return entry.data;
}

async function fetchReviewSummary(appid, options = {}) {
  const response = await requestJson(reviewSummaryUrl(appid), options);
  if (Number(response?.success) !== 1 || !response.query_summary) {
    throw new Error('Steam review summary unavailable');
  }
  return response;
}

function isOfficialSteamMediaUrl(value) {
  if (!value) return false;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === 'https:'
      && (hostname === 'steamstatic.com' || hostname.endsWith('.steamstatic.com'));
  } catch {
    return false;
  }
}

function officialUrl(value) {
  return isOfficialSteamMediaUrl(value) ? value : '';
}

function normalizeMovie(movie = {}) {
  return {
    name: movie.name || '',
    thumbnail: movie.thumbnail || '',
    mp4: movie.mp4?.max || movie.mp4?.['480'] || movie.mp4 || '',
    webm: movie.webm?.max || movie.webm?.['480'] || movie.webm || '',
    hls: movie.hls_h264 || movie.hls || '',
    dash: movie.dash_h264 || movie.dash || '',
  };
}

function normalizeScreenshot(screenshot = {}) {
  const full = officialUrl(typeof screenshot === 'string' ? screenshot : screenshot.path_full || screenshot.full);
  const thumb = officialUrl(typeof screenshot === 'string' ? '' : screenshot.path_thumbnail || screenshot.thumb);
  return { full, thumb };
}

function normalizeReviewSummary(response = {}) {
  const summary = response.query_summary || response;
  const reviewCount = Math.max(0, Number(summary.total_reviews) || 0);
  const positiveCount = Math.max(0, Number(summary.total_positive) || 0);
  return {
    steam_rating: reviewCount > 0 ? Number(((positiveCount / reviewCount) * 100).toFixed(2)) : 75,
    steam_review_count: reviewCount,
    steam_review_summary: summary.review_score_desc || '',
  };
}

function normalizePrice(product) {
  if (product.price_cny !== undefined && product.price_cny !== null) {
    return Number(product.price_cny);
  }
  if (product.is_free) return 0;
  if (!product.price_overview) return null;
  if (String(product.price_overview.currency).toUpperCase() !== 'CNY') {
    throw new Error(`Expected CNY price for Steam App ${product.steam_appid}`);
  }
  return Number(product.price_overview.final) / 100;
}

function normalizeOfficialProduct(product, timestamp) {
  const steam_appid = String(product.steam_appid ?? product.appid ?? product.steam_app_id ?? '');
  const screenshots = (product.screenshots || []).map(normalizeScreenshot).filter(item => item.full);
  const movies = (product.movies || []).map(normalizeMovie).map(movie => ({
    ...movie,
    thumbnail: officialUrl(movie.thumbnail),
    mp4: officialUrl(movie.mp4),
    webm: officialUrl(movie.webm),
    hls: officialUrl(movie.hls),
    dash: officialUrl(movie.dash),
  })).filter(movie => movie.mp4 || movie.webm || movie.hls || movie.dash);
  const headerImage = officialUrl(product.header_image);
  const priceCny = normalizePrice({ ...product, steam_appid });
  const availabilityStatus = product.availability_status
    || (product.is_available === false
      ? 'delisted'
      : priceCny === null ? 'region_unavailable' : 'available');

  const description_en = cleanSteamDescription(product.description_en);
  const description_zh = cleanSteamDescription(product.description_zh);

  return {
    steam_appid,
    type: 'dlc',
    steam_verified: true,
    parent_appid: RPG_MAKER_MZ_APPID,
    fullgame: { appid: RPG_MAKER_MZ_APPID },
    steam_url: `https://store.steampowered.com/app/${steam_appid}/`,
    title_en: product.name || product.title_en || '',
    description_en,
    description_zh,
    description: description_zh || description_en,
    header_image: headerImage,
    screenshots: screenshots.map(item => item.full),
    movies,
    price_cny: priceCny,
    price_status: priceCny === null ? 'unavailable' : product.is_free ? 'free' : 'available',
    availability_status: availabilityStatus,
    steam_rating: Number.isFinite(Number(product.steam_rating)) ? Number(product.steam_rating) : 75,
    steam_review_count: Math.max(0, Number(product.steam_review_count) || 0),
    steam_review_summary: product.steam_review_summary || '',
    release_date: product.release_date?.date || product.release_date || '',
    is_available: availabilityStatus === 'available',
    last_verified_at: timestamp,
    _media: {
      appid: steam_appid,
      name: product.name || product.title_en || '',
      header_image: headerImage,
      capsule_image: officialUrl(product.capsule_image),
      screenshots,
      movies,
      background: officialUrl(product.background_raw || product.background),
    },
  };
}

function safeJson(value, spacing = 2) {
  return JSON.stringify(value, null, spacing).replace(/</g, '\\u003c');
}

function toBrowserDataScript(globalName, value) {
  return `window.${globalName} = ${safeJson(value, 0)};\n`;
}

function buildArtifacts(verified, curated, timestamp, audit = {}) {
  const normalized = verified.map(product => {
    if (!isRpgMakerMzDlc(product)) {
      throw new Error(`Product ${product.steam_appid || product.appid || 'unknown'} is not a verified RPG Maker MZ DLC`);
    }
    return normalizeOfficialProduct(product, timestamp);
  });
  const incompleteBilingual = normalized.filter(product => (
    !product.description_en.trim() || !product.description_zh.trim()
  ));
  if (incompleteBilingual.length) {
    throw new Error(
      `Publication refused: bilingual descriptions are incomplete for Steam App IDs: ${incompleteBilingual
        .map(product => product.steam_appid)
        .join(', ')}`,
    );
  }
  const appids = normalized.map(product => product.steam_appid);
  const duplicates = appids.filter((appid, index) => appids.indexOf(appid) !== index);
  if (duplicates.length) throw new Error(`Duplicate Steam App IDs: ${[...new Set(duplicates)].join(', ')}`);

  const missingCover = normalized.filter(product => !product.header_image);
  if (missingCover.length) {
    const invalid = verified.find(product => !isOfficialSteamMediaUrl(product.header_image));
    const reason = invalid?.header_image ? 'official Steam cover' : 'cover';
    throw new Error(`Publication refused: ${missingCover.length} verified item(s) lack an ${reason}`);
  }

  const media = Object.fromEntries(normalized.map(product => [product.steam_appid, product._media]));
  const official = normalized.map(({ _media, ...product }) => product);
  const catalog = mergeCatalog(official, curated || []).map(product => ({
    ...product,
    sub_category: product.sub_category ?? '',
  }));
  const missingMedia = catalog.filter(product => !media[product.steam_appid]);
  if (missingMedia.length) throw new Error('Publication refused: media coverage is incomplete');

  const unavailable = catalog.filter(product => !product.is_available).length;
  const delisted = catalog.filter(product => product.availability_status === 'delisted').length;
  const regionUnavailable = catalog.filter(product => (
    product.availability_status === 'region_unavailable'
  )).length;
  const screenshotItems = catalog.filter(product => media[product.steam_appid].screenshots.length > 0).length;
  const videoItems = catalog.filter(product => media[product.steam_appid].movies.length > 0).length;
  const screenshotCount = catalog.reduce(
    (total, product) => total + media[product.steam_appid].screenshots.length,
    0,
  );
  const videoCount = catalog.reduce(
    (total, product) => total + media[product.steam_appid].movies.length,
    0,
  );
  const previousCatalog = audit.previousCatalog || curated || [];
  const previousAppids = new Set(previousCatalog
    .filter(product => product?.steam_appid != null)
    .map(product => String(product.steam_appid)));
  const currentAppids = new Set(catalog.map(product => product.steam_appid));
  const added = catalog.filter(product => !previousAppids.has(product.steam_appid)).length;
  const updated = catalog.filter(product => previousAppids.has(product.steam_appid)).length;
  const removed = [...previousAppids].filter(appid => !currentAppids.has(appid)).length;
  const report = {
    generated_at: timestamp,
    parent_appid: RPG_MAKER_MZ_APPID,
    summary: {
      official_discovered: audit.discoveredCount ?? verified.length,
      verified_count: verified.length,
      rejected_count: audit.rejected?.length || 0,
      request_failure_count: audit.failures?.length || 0,
      unavailable_count: unavailable,
      delisted_count: delisted,
      region_unavailable_count: regionUnavailable,
      added_count: added,
      updated_count: updated,
      removed_count: removed,
      duplicate_appids: 0,
      wrong_parent: audit.rejected?.filter(product => (
        String(product.fullgame?.appid) !== RPG_MAKER_MZ_APPID
      )).length || 0,
      missing_cover: 0,
      bilingual_missing: incompleteBilingual.length,
      screenshot_coverage: catalog.length ? screenshotItems / catalog.length : 1,
      video_coverage: catalog.length ? videoItems / catalog.length : 1,
      media_coverage: catalog.length ? (catalog.length - missingMedia.length) / catalog.length : 1,
      discovered: audit.discoveredCount ?? verified.length,
      verified: verified.length,
      rejected: audit.rejected?.length || 0,
      unavailable,
      added,
      updated,
      removed,
      duplicate: 0,
      screenshot: screenshotCount,
      video: videoCount,
      retry: audit.retries?.length || 0,
      failure: audit.failures?.length || 0,
      published: catalog.length,
    },
    retries: audit.retries || [],
    rejected: audit.rejected || [],
    failures: audit.failures || [],
    items: catalog.map(product => ({
      steam_appid: product.steam_appid,
      title_en: product.title_en,
      parent_appid: product.parent_appid,
      verified: product.steam_verified === true,
      is_available: product.is_available,
      has_cover: Boolean(product.header_image),
      screenshot_count: media[product.steam_appid].screenshots.length,
      movie_count: media[product.steam_appid].movies.length,
    })),
  };

  return {
    catalog,
    media,
    report,
    catalogJson: `${safeJson(catalog)}\n`,
    catalogScript: toBrowserDataScript('ALL_STEAM_DLCS', catalog),
    mediaJson: `${safeJson(media)}\n`,
    mediaScript: toBrowserDataScript('STEAM_IMAGES_DATA', media),
    reportJson: `${safeJson(report)}\n`,
  };
}

function preflightFile(filename, content) {
  if (typeof content !== 'string') throw new TypeError(`Artifact ${filename} must be a string`);
  try {
    if (filename.endsWith('.json')) JSON.parse(content);
    else if (filename.endsWith('.js')) new vm.Script(content).runInNewContext({ window: {} });
  } catch (error) {
    throw new Error(`Could not parse artifact ${filename}: ${error.message}`);
  }
}

function publishAtomically(files) {
  const entries = Object.entries(files || {});
  if (!entries.length) throw new Error('No artifact files supplied for publication');
  entries.forEach(([filename, content]) => preflightFile(filename, content));

  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const transaction = entries.map(([target, content], index) => ({
    target,
    content,
    temp: `${target}.tmp-${nonce}-${index}`,
    backup: `${target}.bak-${nonce}-${index}`,
    existed: fs.existsSync(target),
    published: false,
    backedUp: false,
  }));

  try {
    for (const item of transaction) {
      fs.mkdirSync(path.dirname(item.target), { recursive: true });
      fs.writeFileSync(item.temp, item.content, { encoding: 'utf8', flag: 'wx' });
      preflightFile(item.temp.replace(/\.tmp-[^.]+(?:-\d+)?$/, path.extname(item.target)), fs.readFileSync(item.temp, 'utf8'));
    }
    for (const item of transaction) {
      if (item.existed) {
        fs.renameSync(item.target, item.backup);
        item.backedUp = true;
      }
    }
    for (const item of transaction) {
      fs.renameSync(item.temp, item.target);
      item.published = true;
    }
  } catch (error) {
    for (const item of [...transaction].reverse()) {
      try {
        if (item.published && fs.existsSync(item.target)) fs.unlinkSync(item.target);
        if (item.backedUp && fs.existsSync(item.backup)) fs.renameSync(item.backup, item.target);
        if (fs.existsSync(item.temp)) fs.unlinkSync(item.temp);
      } catch {}
    }
    throw new Error(`Atomic publication failed: ${error.message}`);
  }

  // Publication is committed once every target rename succeeds. Backup cleanup
  // is best effort: a cleanup error must never roll back files whose earlier
  // backups may already have been removed.
  for (const item of transaction) {
    try {
      if (item.backedUp && fs.existsSync(item.backup)) fs.unlinkSync(item.backup);
    } catch {}
  }
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function retryOperation(operation, {
  attempts = DEFAULT_ATTEMPTS,
  sleepFn = sleep,
  onRetry = () => {},
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      const delayMs = Math.min(2000, 250 * (2 ** (attempt - 1)));
      onRetry({ attempt, delay_ms: delayMs, error: error instanceof Error ? error.message : String(error) });
      await sleepFn(delayMs);
    }
  }
  throw lastError;
}

async function mapWithConcurrency(values, concurrency, operation) {
  const results = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(values[index], index);
    }
  }
  const workerCount = Math.min(Math.max(1, concurrency), values.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

function loadCuratedCatalog(filename = CURATED_DATA_FILE) {
  const source = fs.readFileSync(filename, 'utf8');
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${source}; globalThis.__allDlcs = ALL_DLCS`, context, { filename });
  return Array.from(context.__allDlcs);
}

function loadPreviousCatalog(filename) {
  try {
    const catalog = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (!Array.isArray(catalog)) throw new Error('canonical catalog is not an array');
    return catalog;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error(`Could not load previous canonical catalog: ${error.message}`);
  }
}

function loadFallbackTranslations(filename = DEFAULT_TRANSLATIONS_FILE) {
  try {
    const translations = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (!translations || Array.isArray(translations) || typeof translations !== 'object') {
      throw new Error('translation fallback must be a JSON object');
    }
    return translations;
  } catch (error) {
    throw new Error(`Could not load Simplified Chinese description fallbacks: ${error.message}`);
  }
}

function artifactFiles(artifacts, outputDir) {
  return {
    [path.join(outputDir, 'dlc-catalog.json')]: artifacts.catalogJson,
    [path.join(outputDir, 'dlc-catalog.js')]: artifacts.catalogScript,
    [path.join(outputDir, 'steam-images.json')]: artifacts.mediaJson,
    [path.join(outputDir, 'steam-images.js')]: artifacts.mediaScript,
    [path.join(outputDir, 'steam-full-sync-report.json')]: artifacts.reportJson,
  };
}

async function syncSteamDlcs(options = {}) {
  const fetchPage = options.fetchPage || fetchCatalogPage;
  const fetchDetails = options.fetchDetails || fetchAppDetails;
  const fetchReviews = options.fetchReviews || fetchReviewSummary;
  const build = options.buildArtifacts || buildArtifacts;
  const curated = options.curated || loadCuratedCatalog(options.curatedFile);
  const timestamp = options.timestamp || new Date().toISOString();
  const sleepFn = options.sleep || sleep;
  const requestScheduler = options.requestScheduler || createRequestScheduler({
    minIntervalMs: options.requestIntervalMs ?? DEFAULT_REQUEST_INTERVAL_MS,
    cooldownMs: options.edgeCooldownMs ?? DEFAULT_EDGE_COOLDOWN_MS,
    now: options.now,
    sleep: sleepFn,
  });
  const publish = options.publish || publishAtomically;
  const outputDir = options.outputDir || DEFAULT_OUTPUT_DIR;
  const previousCatalog = options.previousCatalog !== undefined
    ? options.previousCatalog
    : loadPreviousCatalog(path.join(outputDir, 'dlc-catalog.json'));
  const fallbackTranslations = options.fallbackTranslations !== undefined
    ? options.fallbackTranslations
    : loadFallbackTranslations(options.translationsFile);
  const previousByAppid = new Map(previousCatalog
    .filter(product => product?.steam_appid != null)
    .map(product => [String(product.steam_appid), product]));
  const concurrency = options.concurrency || DEFAULT_CONCURRENCY;
  const retries = [];
  const failures = [];
  const rejected = [];
  const valid = [];

  const appids = await discoverOfficialDlcs(
    (start, pageOptions) => retryOperation(
      () => fetchPage(start, {
        country: 'cn',
        language: 'english',
        timeoutMs: DEFAULT_TIMEOUT_MS,
        count: pageOptions.count,
        requestScheduler,
      }),
      {
        sleepFn,
        onRetry: retry => retries.push({ stage: 'discover', start, ...retry }),
      },
    ),
    { pageSize: options.catalogPageSize || 100 },
  );
  if (appids.length === 0) {
    throw new Error('Steam sync aborted: official catalog discovery returned an empty inventory');
  }
  if (
    previousCatalog.length > 0
    && appids.length < previousCatalog.length
    && options.allowInventoryShrink !== true
  ) {
    throw new Error(
      `Steam sync aborted: discovered inventory shrink (${appids.length} < ${previousCatalog.length}) leaves coverage uncertain`,
    );
  }

  await mapWithConcurrency(appids, concurrency, async appid => {
    const localized = {};
    for (const language of ['english', 'schinese']) {
      try {
        localized[language] = await retryOperation(
          () => fetchDetails(appid, {
            country: 'cn',
            language,
            timeoutMs: DEFAULT_TIMEOUT_MS,
            requestScheduler,
          }),
          {
            sleepFn,
            onRetry: retry => retries.push({
              stage: 'details', steam_appid: appid, language, ...retry,
            }),
          },
        );
      } catch (error) {
        failures.push({
          stage: 'details', steam_appid: appid, language, error: error.message,
        });
        return;
      }
    }

    let product = { ...localized.english, steam_appid: String(appid) };
    if (!isRpgMakerMzDlc(product)) {
      rejected.push(product);
      return;
    }

    let descriptions;
    try {
      descriptions = mergeLocalizedDescriptions({
        appid,
        english: localized.english,
        schinese: localized.schinese,
        previous: previousByAppid.get(String(appid)),
        fallbackTranslations,
      });
    } catch (error) {
      failures.push({
        stage: 'details', steam_appid: appid, language: 'localized', error: error.message,
      });
      return;
    }

    product = {
      ...product,
      ...descriptions,
    };

    try {
      const reviews = await retryOperation(
        () => fetchReviews(appid, {
          language: 'all',
          timeoutMs: DEFAULT_TIMEOUT_MS,
          requestScheduler,
        }),
        {
          sleepFn,
          onRetry: retry => retries.push({ stage: 'reviews', steam_appid: appid, ...retry }),
        },
      );
      valid.push({ ...product, ...normalizeReviewSummary(reviews) });
    } catch (error) {
      failures.push({ stage: 'reviews', steam_appid: appid, error: error.message });
    }
  });

  const discoveryOrder = new Map(appids.map((appid, index) => [String(appid), index]));
  const byDiscoveryOrder = (left, right) => (
    discoveryOrder.get(String(left.steam_appid)) - discoveryOrder.get(String(right.steam_appid))
  );
  valid.sort(byDiscoveryOrder);
  rejected.sort(byDiscoveryOrder);
  failures.sort(byDiscoveryOrder);

  if (failures.length) {
    const evidence = failures.map(failure => (
      `${failure.stage}:${failure.steam_appid}:${failure.language || 'unknown'}`
    )).join(', ');
    throw new Error(
      `Steam sync aborted: ${failures.length} request failure(s) leave catalog coverage uncertain (${evidence})`,
    );
  }
  if (valid.length === 0) {
    throw new Error('Steam sync aborted: no discovered candidate passed RPG Maker MZ validation');
  }
  if (previousCatalog.length > 0 && options.allowInventoryShrink !== true) {
    const verifiedAppids = new Set(valid.map(product => product.steam_appid));
    const missingPreviousAppids = previousCatalog
      .filter(product => product?.steam_appid != null)
      .map(product => String(product.steam_appid))
      .filter(appid => !verifiedAppids.has(appid));
    if (missingPreviousAppids.length > 0) {
      throw new Error(
        `Steam sync aborted: verified inventory shrink removed ${missingPreviousAppids.length} prior App ID(s)`,
      );
    }
  }

  const artifacts = build(valid, curated, timestamp, {
    discoveredCount: appids.length,
    rejected,
    failures,
    retries,
    previousCatalog,
  });
  const files = artifactFiles(artifacts, outputDir);
  publish(files);
  return { artifacts, files };
}

async function runCli(argv = [], { sync = syncSteamDlcs, log = console.log } = {}) {
  if (argv.includes('--help') || argv.includes('-h')) {
    log(CLI_USAGE);
    return { help: true };
  }
  if (argv.length > 0) {
    throw new Error(`Unknown argument: ${argv[0]}\n${CLI_USAGE}`);
  }

  const { artifacts, files } = await sync();
  const summary = artifacts.report.summary;
  log(`Official discovered: ${summary.official_discovered}`);
  log(`Verified: ${summary.verified_count}`);
  log(`Rejected: ${summary.rejected_count}`);
  log(`Duplicate App IDs: ${summary.duplicate_appids}`);
  log(`Missing covers: ${summary.missing_cover}`);
  Object.keys(files).forEach(filename => log(`Published: ${filename}`));
  return { artifacts, files };
}

function main(argv = process.argv.slice(2)) {
  return runCli(argv);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  RPG_MAKER_MZ_APPID,
  DEFAULT_REQUEST_INTERVAL_MS,
  DEFAULT_EDGE_COOLDOWN_MS,
  CLI_USAGE,
  createRequestScheduler,
  catalogPageUrl,
  appDetailsUrl,
  reviewSummaryUrl,
  requestText,
  requestJson,
  fetchCatalogPage,
  parseCatalogPage,
  discoverOfficialDlcs,
  fetchAppDetails,
  fetchReviewSummary,
  isOfficialSteamMediaUrl,
  normalizeMovie,
  normalizeReviewSummary,
  normalizeOfficialProduct,
  toBrowserDataScript,
  buildArtifacts,
  publishAtomically,
  retryOperation,
  mapWithConcurrency,
  loadCuratedCatalog,
  loadPreviousCatalog,
  loadFallbackTranslations,
  artifactFiles,
  syncSteamDlcs,
  runCli,
  main,
};
