/*
 * CaptionFlow Crunchyroll page-world bridge.
 * Runs inside the Crunchyroll player frame (static.crunchyroll.com) and reads
 * the vilos player configuration, which lists every subtitle track the player
 * itself downloads (ASS/VTT files with per-locale signed URLs).
 * Speaks the same request protocol as youtube-main.js.
 */
(() => {
  'use strict';
  if (window.__captionFlowCrunchyrollMainInstalled) return;
  window.__captionFlowCrunchyrollMainInstalled = true;

  const SOURCE_REQUEST = 'captionflow-extension';
  const SOURCE_RESPONSE = 'captionflow-page';

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function readPlayerConfig() {
    // The player has shipped its config under a few globals over time; probe
    // them all so a Crunchyroll refactor degrades gracefully instead of breaking.
    const candidates = [
      window.v1config,
      window.vilos?.config,
      window.vilosConfig,
      window.__INITIAL_STATE__?.content?.media,
    ];
    for (const candidate of candidates) {
      const media = candidate?.media || candidate?.player?.media || candidate;
      if (!media || typeof media !== 'object') continue;
      const subtitles = [].concat(media.subtitles || [], media.captions || []);
      if (subtitles.some((item) => item?.url)) return { media, subtitles };
    }
    return null;
  }

  function languageLabel(code) {
    const clean = String(code || '').replace(/_/g, '-');
    try {
      const label = new Intl.DisplayNames(['en'], { type: 'language' }).of(clean);
      if (label && label.toLowerCase() !== clean.toLowerCase()) return label;
    } catch { /* unknown or malformed locale code */ }
    return clean || 'Unknown';
  }

  function mediaTitle(media) {
    const metadata = media?.metadata || {};
    const series = metadata.series_title || metadata.seriesTitle || '';
    const episodeNumber = metadata.episode_number || metadata.episodeNumber || '';
    const title = metadata.title || document.title.replace(/\s*[-|].*Crunchyroll.*$/i, '').trim();
    const episode = episodeNumber ? `Episode ${episodeNumber}` : '';
    return [series, episode, title].filter(Boolean).join(' - ') || 'Crunchyroll video';
  }

  function normalizeTracks(subtitles) {
    const map = new Map();
    for (const item of subtitles) {
      if (!item?.url) continue;
      let url;
      try {
        url = new URL(item.url, location.href).toString();
      } catch {
        continue;
      }
      const language = String(item.language || item.locale || 'unknown');
      const format = String(item.format || (url.includes('.vtt') ? 'vtt' : 'ass')).toLowerCase();
      const key = `${language}|${format}|${url}`;
      if (map.has(key)) continue;
      map.set(key, {
        key,
        id: '',
        label: item.title || languageLabel(language),
        language,
        kind: 'manual',
        source: 'crunchyroll',
        format,
        urls: [url],
        isTranslatable: false,
      });
    }
    return [...map.values()].map((track, index) => ({ ...track, id: `cr-${index + 1}` }));
  }

  async function discoverTracks() {
    // The config appears once the player boots; wait for it like the YouTube
    // bridge waits for the player API.
    const deadline = Date.now() + 8000;
    let found = null;
    while (Date.now() < deadline) {
      found = readPlayerConfig();
      if (found) break;
      await sleep(300);
    }
    if (!found) {
      throw new Error('Crunchyroll has not exposed subtitle tracks yet. Start the video, then tap Refresh.');
    }
    return {
      videoId: String(found.media?.metadata?.id || ''),
      title: mediaTitle(found.media),
      tracks: normalizeTracks(found.subtitles),
    };
  }

  async function fetchTrack(track) {
    if (!track || !Array.isArray(track.urls)) throw new Error('Invalid Crunchyroll subtitle track.');
    let lastError;
    for (const url of track.urls) {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Crunchyroll returned HTTP ${response.status}.`);
        const text = await response.text();
        if (!text.trim()) throw new Error('Crunchyroll returned an empty subtitle file.');
        return { text, format: track.format || 'ass' };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('The selected Crunchyroll subtitle could not be downloaded.');
  }

  async function handleRequest(message) {
    if (message.action === 'GET_TRACKS') return await discoverTracks();
    if (message.action === 'FETCH_TRACK') return await fetchTrack(message.track);
    throw new Error(`Unknown CaptionFlow page action: ${message.action}`);
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.data?.source !== SOURCE_REQUEST || !event.data?.requestId) return;
    const { requestId } = event.data;
    try {
      const payload = await handleRequest(event.data);
      window.postMessage({ source: SOURCE_RESPONSE, requestId, ok: true, payload }, '*');
    } catch (error) {
      window.postMessage({
        source: SOURCE_RESPONSE,
        requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }, '*');
    }
  });
})();
