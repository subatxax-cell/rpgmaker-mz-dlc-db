const RPG_MAKER_MZ_APPID = '1096900';
const APP_ID_PATTERN = /data-ds-appid=["'](\d+)["']/g;

function extractAppIds(html) {
  return Array.from(String(html || '').matchAll(APP_ID_PATTERN), match => match[1]);
}

async function discoverAllDlcs(fetchPage) {
  const appids = new Set();

  for (let page = 1; ; page += 1) {
    const pageAppids = extractAppIds(await fetchPage(page));
    if (pageAppids.length === 0) break;
    pageAppids.forEach(appid => appids.add(appid));
  }

  return Array.from(appids);
}

function isRpgMakerMzDlc(appData) {
  return appData?.type === 'dlc' && String(appData.fullgame?.appid) === RPG_MAKER_MZ_APPID;
}

async function verifyProducts(appids, fetchDetails) {
  const valid = [];
  const rejected = [];
  const failures = [];

  for (const appid of appids) {
    const steam_appid = String(appid);
    try {
      const product = { ...(await fetchDetails(steam_appid)), steam_appid };
      (isRpgMakerMzDlc(product) ? valid : rejected).push(product);
    } catch (error) {
      failures.push({ steam_appid, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { valid, rejected, failures };
}

module.exports = {
  extractAppIds,
  discoverAllDlcs,
  isRpgMakerMzDlc,
  verifyProducts,
};
