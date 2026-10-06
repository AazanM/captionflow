/*
 * CaptionFlow subtitle utilities.
 * YouTube timed-text handling is adapted from ideas in asbplayer
 * (MIT License, Copyright 2020-2026 asbplayer authors).
 */
(function (root, factory) {
  const api = factory();
  root.CaptionFlowSubtitles = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function normalizeNewlines(text) {
    return String(text ?? '').replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
  }

  function decodeEntities(value) {
    const text = String(value ?? '');
    if (typeof document !== 'undefined') {
      const textarea = document.createElement('textarea');
      textarea.innerHTML = text;
      return textarea.value;
    }
    return text
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&apos;/gi, "'");
  }

  function stripTags(value) {
    return decodeEntities(String(value ?? '').replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, ''));
  }

  function parseClock(value) {
    const clean = String(value ?? '').trim().replace(',', '.');
    const parts = clean.split(':').map(Number);
    if (parts.some(Number.isNaN)) return NaN;
    if (parts.length === 3) return Math.round((parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000);
    if (parts.length === 2) return Math.round((parts[0] * 60 + parts[1]) * 1000);
    if (parts.length === 1) return Math.round(parts[0] * 1000);
    return NaN;
  }

  function cleanCueText(text) {
    return stripTags(text)
      .replace(/\u200B/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function finalizeCues(cues) {
    const normalized = cues
      .filter((cue) => Number.isFinite(cue.startMs) && Number.isFinite(cue.endMs) && cue.endMs >= cue.startMs)
      .map((cue, index) => ({
        id: cue.id || `cue-${index}`,
        startMs: Math.max(0, Math.round(cue.startMs)),
        endMs: Math.max(0, Math.round(cue.endMs)),
        text: cleanCueText(cue.text),
      }))
      .filter((cue) => cue.text.length > 0)
      .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

    for (let i = 0; i < normalized.length - 1; i += 1) {
      const current = normalized[i];
      const next = normalized[i + 1];
      if (current.endMs > next.startMs && next.startMs > current.startMs) {
        current.endMs = Math.max(current.startMs + 40, next.startMs - 1);
      }
    }
    return normalized;
  }

  function parseSrt(text) {
    const blocks = normalizeNewlines(text).trim().split(/\n{2,}/);
    const cues = [];
    for (const block of blocks) {
      const lines = block.split('\n');
      let timingIndex = lines.findIndex((line) => line.includes('-->'));
      if (timingIndex < 0) continue;
      const match = lines[timingIndex].match(/([^\s]+)\s*-->\s*([^\s]+)/);
      if (!match) continue;
      const startMs = parseClock(match[1]);
      const endMs = parseClock(match[2]);
      cues.push({ startMs, endMs, text: lines.slice(timingIndex + 1).join('\n') });
    }
    return finalizeCues(cues);
  }

  function parseVtt(text) {
    const source = normalizeNewlines(text)
      .replace(/^WEBVTT[^\n]*\n+/, '')
      .replace(/^NOTE[^\n]*(?:\n(?!\n).*)*/gm, '');
    const blocks = source.trim().split(/\n{2,}/);
    const cues = [];
    for (const block of blocks) {
      const lines = block.split('\n');
      const timingIndex = lines.findIndex((line) => line.includes('-->'));
      if (timingIndex < 0) continue;
      const match = lines[timingIndex].match(/([^\s]+)\s*-->\s*([^\s]+)/);
      if (!match) continue;
      cues.push({
        startMs: parseClock(match[1]),
        endMs: parseClock(match[2]),
        text: lines.slice(timingIndex + 1).join('\n').replace(/<\d\d:\d\d(?::\d\d)?\.\d+>/g, ''),
      });
    }
    return finalizeCues(cues);
  }

  function parseAssTime(value) {
    const match = String(value).trim().match(/^(\d+):(\d{1,2}):(\d{1,2})[.](\d{1,2})$/);
    if (!match) return NaN;
    return (((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000) + Number(match[4].padEnd(3, '0'));
  }

  function parseAss(text) {
    const lines = normalizeNewlines(text).split('\n');
    let inEvents = false;
    let format = ['Layer', 'Start', 'End', 'Style', 'Name', 'MarginL', 'MarginR', 'MarginV', 'Effect', 'Text'];
    const cues = [];
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (/^\[Events\]$/i.test(line)) {
        inEvents = true;
        continue;
      }
      if (/^\[/.test(line) && !/^\[Events\]$/i.test(line)) {
        inEvents = false;
        continue;
      }
      if (!inEvents) continue;
      if (/^Format:/i.test(line)) {
        format = line.slice(line.indexOf(':') + 1).split(',').map((item) => item.trim());
        continue;
      }
      if (!/^Dialogue:/i.test(line)) continue;
      const payload = line.slice(line.indexOf(':') + 1).trim();
      const values = [];
      let rest = payload;
      for (let i = 0; i < format.length - 1; i += 1) {
        const comma = rest.indexOf(',');
        if (comma < 0) break;
        values.push(rest.slice(0, comma));
        rest = rest.slice(comma + 1);
      }
      values.push(rest);
      const row = Object.fromEntries(format.map((key, index) => [key.toLowerCase(), values[index] ?? '']));
      cues.push({
        startMs: parseAssTime(row.start),
        endMs: parseAssTime(row.end),
        text: row.text.replace(/\{[^}]*\}/g, '').replace(/\\N|\\n/g, '\n').replace(/\\h/g, ' '),
      });
    }
    return finalizeCues(cues);
  }

  function attributesMap(text) {
    const result = {};
    String(text).replace(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g, (_, key, _quote, value) => {
      result[key] = decodeEntities(value);
      return '';
    });
    return result;
  }

  function parseYoutubeJson3(payload) {
    const json = typeof payload === 'string' ? JSON.parse(payload) : payload;
    const events = Array.isArray(json?.events) ? json.events : [];
    const cues = [];
    for (const event of events) {
      if (!Number.isFinite(event.tStartMs)) continue;
      const text = (event.segs || []).map((segment) => segment.utf8 || '').join('').trim();
      if (!text || text === '\n') continue;
      cues.push({
        startMs: event.tStartMs,
        endMs: event.tStartMs + (Number(event.dDurationMs) || 2000),
        text,
      });
    }
    return finalizeCues(cues);
  }

  function parseYoutubeSrv3(text) {
    const source = normalizeNewlines(text).trim();
    if (!source) return [];
    if (source.startsWith('{')) return parseYoutubeJson3(source);

    const cues = [];
    const pRegex = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
    let match;
    while ((match = pRegex.exec(source))) {
      const attrs = attributesMap(match[1]);
      const startMs = Number(attrs.t ?? attrs.start ?? attrs.begin);
      let durationMs = Number(attrs.d ?? attrs.dur ?? attrs.duration);
      if (!Number.isFinite(startMs)) continue;
      if (!Number.isFinite(durationMs)) durationMs = 2000;
      const textValue = cleanCueText(match[2].replace(/<s\b[^>]*>/gi, '').replace(/<\/s>/gi, ''));
      if (!textValue) continue;
      cues.push({ startMs, endMs: startMs + durationMs, text: textValue });
    }

    if (cues.length === 0) {
      const textRegex = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
      while ((match = textRegex.exec(source))) {
        const attrs = attributesMap(match[1]);
        const start = Number(attrs.start);
        const duration = Number(attrs.dur ?? attrs.duration ?? 2);
        if (!Number.isFinite(start)) continue;
        cues.push({ startMs: start * 1000, endMs: (start + duration) * 1000, text: match[2] });
      }
    }
    return finalizeCues(cues);
  }

  function parseSubtitle(text, filename = '') {
    const lower = filename.toLowerCase();
    if (lower.endsWith('.srt')) return parseSrt(text);
    if (lower.endsWith('.vtt')) return parseVtt(text);
    if (lower.endsWith('.ass') || lower.endsWith('.ssa')) return parseAss(text);
    if (lower.endsWith('.ytsrv3') || lower.endsWith('.xml') || lower.endsWith('.srv3')) return parseYoutubeSrv3(text);
    const normalized = normalizeNewlines(text).trim();
    if (normalized.startsWith('WEBVTT')) return parseVtt(normalized);
    if (normalized.startsWith('{') && normalized.includes('events')) return parseYoutubeJson3(normalized);
    if (normalized.startsWith('<')) return parseYoutubeSrv3(normalized);
    return parseSrt(normalized);
  }

  function pad(value, length = 2) {
    return String(value).padStart(length, '0');
  }

  function formatTimestamp(ms, separator) {
    const total = Math.max(0, Math.round(ms));
    const hours = Math.floor(total / 3600000);
    const minutes = Math.floor((total % 3600000) / 60000);
    const seconds = Math.floor((total % 60000) / 1000);
    const millis = total % 1000;
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${separator}${pad(millis, 3)}`;
  }

  function toSrt(cues) {
    return finalizeCues(cues)
      .map((cue, index) => `${index + 1}\n${formatTimestamp(cue.startMs, ',')} --> ${formatTimestamp(cue.endMs, ',')}\n${cue.text}`)
      .join('\n\n') + '\n';
  }

  function toVtt(cues) {
    return 'WEBVTT\n\n' + finalizeCues(cues)
      .map((cue) => `${formatTimestamp(cue.startMs, '.')} --> ${formatTimestamp(cue.endMs, '.')}\n${cue.text}`)
      .join('\n\n') + '\n';
  }

  function serialize(cues, format) {
    return String(format).toLowerCase() === 'vtt' ? toVtt(cues) : toSrt(cues);
  }

  function activeTextAt(cues, timeMs) {
    if (!cues.length) return '';
    let low = 0;
    let high = cues.length - 1;
    let candidate = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (cues[mid].startMs <= timeMs) {
        candidate = mid;
        low = mid + 1;
      } else high = mid - 1;
    }
    if (candidate < 0) return '';
    const active = [];
    for (let i = candidate; i >= 0 && candidate - i < 16; i -= 1) {
      const cue = cues[i];
      if (cue.endMs < timeMs && active.length) break;
      if (cue.startMs <= timeMs && cue.endMs >= timeMs) active.unshift(cue.text);
    }
    return active.join('\n');
  }

  return {
    parseClock,
    parseSrt,
    parseVtt,
    parseAss,
    parseYoutubeSrv3,
    parseYoutubeJson3,
    parseSubtitle,
    toSrt,
    toVtt,
    serialize,
    activeTextAt,
    finalizeCues,
  };
});
