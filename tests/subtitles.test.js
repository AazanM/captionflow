const assert = require('assert');
const subs = require('../lib/subtitles.js');

const srt = `1\n00:00:01,000 --> 00:00:03,500\nHello world.\n\n2\n00:00:04,000 --> 00:00:05,000\nSecond line.`;
const srtCues = subs.parseSrt(srt);
assert.equal(srtCues.length, 2);
assert.equal(srtCues[0].startMs, 1000);
assert.equal(srtCues[0].endMs, 3500);
assert.equal(subs.activeTextAt(srtCues, 2000), 'Hello world.');

const vtt = `WEBVTT\n\n00:00:01.000 --> 00:00:02.000 align:center\n<c.green>Hello</c>\n\n00:00:03.000 --> 00:00:04.000\nWorld`;
const vttCues = subs.parseVtt(vtt);
assert.equal(vttCues.length, 2);
assert.equal(vttCues[0].text, 'Hello');

const ass = `[Script Info]\nTitle: Test\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\b1}Hello\\Nworld`;
const assCues = subs.parseAss(ass);
assert.equal(assCues.length, 1);
assert.equal(assCues[0].text, 'Hello\nworld');

const srv3 = `<timedtext><body><p t="1000" d="2500"><s>Hello </s><s>world</s></p><p t="4000" d="1000">Next</p></body></timedtext>`;
const ytCues = subs.parseYoutubeSrv3(srv3);
assert.equal(ytCues.length, 2);
assert.equal(ytCues[0].text, 'Hello world');
assert.equal(ytCues[0].startMs, 1000);

const json3 = JSON.stringify({ events: [{ tStartMs: 500, dDurationMs: 1000, segs: [{ utf8: 'Hi ' }, { utf8: 'there' }] }] });
const jsonCues = subs.parseYoutubeSrv3(json3);
assert.equal(jsonCues[0].text, 'Hi there');

const output = subs.toSrt(ytCues);
assert(output.includes('00:00:01,000 --> 00:00:03,500'));
assert(output.includes('Hello world'));

console.log('CaptionFlow subtitle tests passed.');
