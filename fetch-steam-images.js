/**
 * Backward-compatible entry point for the Steam-official full DLC sync.
 *
 * Usage: node fetch-steam-images.js
 * Output: the canonical catalog, media cache, browser scripts, and audit report.
 */

const {
  main: fullSyncMain,
  syncSteamDlcs,
} = require('./sync-steam-dlcs');
const compatibility = require('./lib/steam-media');

async function main(options) {
  return options ? syncSteamDlcs(options) : fullSyncMain();
}

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { ...compatibility, main };
