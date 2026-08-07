/**
 * Shared legacy Steam media compatibility helpers.
 *
 * The canonical publication path lives in sync-steam-dlcs.js. These helpers
 * remain only for callers of the former fetch-steam-images.js module API.
 */

const https = require('node:https');
const vm = require('node:vm');
const {
  fetchAppDetails,
  normalizeMovie,
  toBrowserDataScript: sharedBrowserDataScript,
} = require('../sync-steam-dlcs');

function parseSteamTarget(url) {
  const match = String(url || '').match(/store\.steampowered\.com\/(app|bundle)\/(\d+)/i);
  return match ? { type: match[1].toLowerCase(), id: match[2] } : null;
}

function extractVerifiedTargets(code) {
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${code}; globalThis.__dlcs = ALL_DLCS`, context);
  return Array.from(context.__dlcs)
    .filter(dlc => dlc.steam_verified !== false)
    .map(dlc => parseSteamTarget(dlc.steam_url))
    .filter(Boolean);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function toBrowserDataScript(data) {
  return sharedBrowserDataScript('STEAM_IMAGES_DATA', data);
}

function mergeMediaRecord(manual = {}, steam = {}) {
  const manualShots = (manual.screenshots || []).map(item => (
    typeof item === 'string' ? item : item.full
  ));
  const steamShots = (steam.screenshots || []).map(item => (
    typeof item === 'string' ? item : item.full
  ));
  return { ...steam, screenshots: unique([...manualShots, ...steamShots]) };
}

function mergeSuccessfulResults(cached = {}, refreshed = []) {
  const merged = { ...cached };
  refreshed.forEach(record => {
    if (record && !record.error) merged[record.appid || record.id] = record;
  });
  return merged;
}

function decodeStoreValue(value = '') {
  return value.replace(/\\\//g, '/').replace(/&amp;/g, '&').replace(/&#x2F;/gi, '/');
}

function metaContent(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const first = html.match(new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']+)`, 'i'));
  const second = html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escaped}["']`, 'i'));
  return decodeStoreValue((first || second || [])[1] || '');
}

function extractStoreMedia(html, type, id) {
  const normalized = decodeStoreValue(html);
  const urls = normalized.match(/https?:\/\/[^"'<>\s]+/g) || [];
  const screenshots = unique(urls.filter(url => (
    /\/ss_[^/]+(?:\.1920x1080)?\.(?:jpg|png)(?:\?|$)/i.test(url)
  ))).map(full => ({ full, thumb: '' }));
  const movieUrls = unique(urls.filter(url => (
    /(?:movie|highlight)[^"'<>\s]*\.(?:mp4|webm)(?:\?|$)/i.test(url)
  )));
  const movies = movieUrls.map(url => ({
    mp4: /\.mp4(?:\?|$)/i.test(url) ? url : '',
    webm: /\.webm(?:\?|$)/i.test(url) ? url : '',
    thumbnail: '',
  }));
  return {
    appid: id,
    type,
    name: metaContent(html, 'og:title'),
    header_image: metaContent(html, 'og:image'),
    capsule_image: '',
    screenshots,
    movies,
    background: '',
  };
}

function resolveRedirectUrl(location, currentUrl) {
  return new URL(location, currentUrl).toString();
}

function fetchStorePage(target, requestUrl, redirects = 0) {
  return new Promise(resolve => {
    const url = requestUrl || `https://store.steampowered.com/${target.type}/${target.id}/?l=english&cc=us`;
    const request = https.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 SteamMediaFetcher/2.0',
        Cookie: 'birthtime=0; lastagecheckage=1-January-1970; mature_content=1',
      },
    }, response => {
      if (
        response.statusCode >= 300
        && response.statusCode < 400
        && response.headers.location
        && redirects < 5
      ) {
        response.resume();
        resolve(fetchStorePage(
          target,
          resolveRedirectUrl(response.headers.location, url),
          redirects + 1,
        ));
        return;
      }
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        const record = extractStoreMedia(body, target.type, target.id);
        resolve(record.header_image || record.screenshots.length || record.movies.length
          ? record
          : { appid: target.id, error: `store_page_${response.statusCode}` });
      });
    });
    request.on('error', error => resolve({ appid: target.id, error: error.message }));
    request.on('timeout', () => {
      request.destroy();
      resolve({ appid: target.id, error: 'timeout' });
    });
  });
}

async function fetchAPI(appid) {
  try {
    const data = await fetchAppDetails(appid, { timeoutMs: 15000 });
    return {
      appid,
      name: data.name || '',
      header_image: data.header_image || '',
      capsule_image: data.capsule_image || '',
      screenshots: (data.screenshots || []).map(screenshot => ({
        full: screenshot.path_full || '',
        thumb: screenshot.path_thumbnail || '',
      })),
      movies: (data.movies || []).map(normalizeMovie),
      background: data.background_raw || '',
    };
  } catch (error) {
    return { appid, error: error.message };
  }
}

module.exports = {
  parseSteamTarget,
  extractVerifiedTargets,
  mergeMediaRecord,
  mergeSuccessfulResults,
  extractStoreMedia,
  normalizeMovie,
  resolveRedirectUrl,
  toBrowserDataScript,
  fetchAPI,
  fetchStorePage,
};
