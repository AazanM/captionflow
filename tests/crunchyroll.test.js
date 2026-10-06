'use strict';

/*
 * Crunchyroll integration checks: the manifest wiring, the page bridge, and
 * the ASS-format path Crunchyroll subtitles travel through.
 * Run with: node tests/crunchyroll.test.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const manifest = JSON.parse(read('manifest.json'));
const content = read('content.js');
const bridge = read('crunchyroll-main.js');
const background = read('background.js');

// Manifest: the bridge must run in the player iframe on static.crunchyroll.com.
const crunchyrollEntry = manifest.content_scripts.find((entry) => entry.js.includes('crunchyroll-main.js'));
assert.ok(crunchyrollEntry, 'crunchyroll-main.js must be registered as a content script');
assert.strictEqual(crunchyrollEntry.world, 'MAIN', 'the Crunchyroll bridge must run in the page world');
assert.ok(crunchyrollEntry.all_frames, 'the Crunchyroll bridge must run in the player iframe');
assert.ok(crunchyrollEntry.matches.includes('https://static.crunchyroll.com/*'), 'the bridge must match the player frame origin');
assert.ok(manifest.host_permissions.includes('https://www.crunchyroll.com/*'), 'Crunchyroll host permission must be declared');

// Bridge: same protocol as the YouTube bridge, vilos config discovery, and
// multiple config generations probed.
for (const marker of ['captionflow-extension', 'captionflow-page', 'GET_TRACKS', 'FETCH_TRACK', 'v1config', 'subtitles', 'captions']) {
  assert.ok(bridge.includes(marker), `crunchyroll-main.js must contain ${marker}`);
}

// Content: site adapter, generalized track fetch, native button injection,
// and iframe-aware sidebar toggling.
for (const marker of ["'crunchyroll'", 'SITE_SUPPORTS_TRACKS', 'siteTracks', 'fetchSiteCues', 'siteControlContainers', 'cf-cr-button', 'parseSubtitle(result.text']) {
  assert.ok(content.includes(marker), `content.js must contain ${marker}`);
}
assert.ok(!content.includes("frameId: 0") && !background.includes('frameId: 0'), 'the sidebar toggle must reach player iframes, not only the top frame');

// Subtitle library: Crunchyroll serves ASS; it must parse and re-serialize.
const subtitles = require('../lib/subtitles.js');
const sampleAss = [
  '[Script Info]',
  'Title: sample',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  'Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,Hello there!',
  'Dialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,Line two\\Nsecond row',
].join('\n');

const cues = subtitles.parseSubtitle(sampleAss, 'captions.ass');
assert.strictEqual(cues.length, 2, 'ASS sample must produce two cues');
assert.strictEqual(cues[0].text, 'Hello there!', 'ASS text must parse cleanly');
assert.ok(cues[1].text.includes('\n'), 'ASS \\N must become a line break');
const srt = subtitles.serialize(cues, 'srt');
assert.ok(srt.includes('00:00:01,000 --> 00:00:03,500'), 'ASS cues must serialize to SRT timestamps');

console.log('CaptionFlow Crunchyroll integration tests passed.');
