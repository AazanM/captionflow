/*
 * CaptionFlow YouTube page-world bridge.
 * Caption discovery strategy adapted from asbplayer (MIT).
 */
(() => {
  'use strict';
  if (window.__captionFlowYoutubeMainInstalled) return;
  window.__captionFlowYoutubeMainInstalled = true;

  const SOURCE_REQUEST = 'captionflow-extension';
  const SOURCE_RESPONSE = 'captionflow-page';

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function inferVideoId() {
    const match = location.pathname.match(/^\/(?:shorts|embed)\/([^/?]+)/);
    if (match?.[1]) return match[1];
    return new URLSearchParams(location.search).get('v') || undefined;
  }

  function trackLabel(track) {
    return track?.name?.simpleText || track?.name?.runs?.[0]?.text || track?.displayName || track?.languageName || track?.languageCode || 'Unknown';
  }

  function trackKind(track) {
    const raw = String(track?.kind || track?.vssId || '').toLowerCase();
    if (raw === 'asr' || raw.startsWith('a.') || raw.includes('asr')) return 'auto';
    return 'manual';
  }

  function safeUrl(input) {
    try {
      const url = new URL(input, location.href);
      if (!/(^|\.)youtube\.com$/i.test(url.hostname) && !/(^|\.)youtube-nocookie\.com$/i.test(url.hostname)) return undefined;
      url.searchParams.set('fmt', 'srv3');
      const clientName = window.ytcfg?.get?.('INNERTUBE_CLIENT_NAME');
      if (clientName) url.searchParams.set('c', clientName);
      return url.toString();
    } catch {
      return undefined;
    }
  }

  function normalizeTrack(track, source) {
    const language = track?.languageCode;
    const url = safeUrl(track?.url || track?.baseUrl);
    if (!language || !url) return undefined;
    const kind = trackKind(track);
    const label = trackLabel(track);
    const stable = `${track?.vssId || ''}|${language}|${kind}|${label}`;
    return {
      key: stable,
      id: '',
      label,
      language,
      kind,
      source,
      urls: [url],
      isTranslatable: Boolean(track?.isTranslatable),
    };
  }

  function mergeTracks(trackGroups) {
    const map = new Map();
    for (const group of trackGroups) {
      for (const track of group || []) {
        const item = normalizeTrack(track.value ?? track, track.source ?? 'youtube');
        if (!item) continue;
        const existing = map.get(item.key);
        if (existing) {
          for (const url of item.urls) if (!existing.urls.includes(url)) existing.urls.push(url);
        } else map.set(item.key, item);
      }
    }
    return [...map.values()].map((track, index) => ({ ...track, id: `yt-${index + 1}` }));
  }

  async function runtimeTracks(videoId) {
    const deadline = Date.now() + 5500;
    while (Date.now() < deadline) {
      try {
        const player = document.querySelector('#movie_player');
        const currentId = player?.getVideoData?.()?.video_id;
        let tracks = player?.getAudioTrack?.()?.captionTracks;
        if (!Array.isArray(tracks) || tracks.length === 0) {
          tracks = player?.getOption?.('captions', 'tracklist');
        }
        if ((!currentId || currentId === videoId) && Array.isArray(tracks) && tracks.length) {
          return {
            title: player?.getVideoData?.()?.title || '',
            tracks: tracks.map((value) => ({ value, source: 'runtime' })),
          };
        }
      } catch {
        // The player can briefly expose methods that throw during YouTube SPA navigation.
      }
      await sleep(250);
    }
    return { title: '', tracks: [] };
  }

  function initialResponseTracks() {
    const response = window.ytInitialPlayerResponse;
    const tracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    return {
      title: response?.videoDetails?.title || '',
      tracks: Array.isArray(tracks) ? tracks.map((value) => ({ value, source: 'initial' })) : [],
    };
  }

  async function androidInnerTubeTracks(videoId) {
    const apiKey = window.ytcfg?.get?.('INNERTUBE_API_KEY');
    if (!apiKey) return { title: '', tracks: [] };
    try {
      const response = await fetch(`${location.origin}/youtubei/v1/player?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          context: {
            client: {
              clientName: 'ANDROID',
              clientVersion: '20.10.38',
              hl: window.ytcfg?.get?.('HL') || 'en',
            },
          },
          videoId,
        }),
      });
      if (!response.ok) return { title: '', tracks: [] };
      const payload = await response.json();
      const tracks = payload?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      return {
        title: payload?.videoDetails?.title || '',
        tracks: Array.isArray(tracks) ? tracks.map((value) => ({ value, source: 'android' })) : [],
      };
    } catch {
      return { title: '', tracks: [] };
    }
  }

  async function discoverTracks() {
    const videoId = inferVideoId();
    if (!videoId) throw new Error('CaptionFlow could not determine the YouTube video ID.');

    const runtime = await runtimeTracks(videoId);
    const initial = initialResponseTracks();
    let android = { title: '', tracks: [] };
    if (runtime.tracks.length === 0 || initial.tracks.length === 0) android = await androidInnerTubeTracks(videoId);

    const tracks = mergeTracks([runtime.tracks, initial.tracks, android.tracks]);
    return {
      videoId,
      title: runtime.title || initial.title || android.title || document.title.replace(/\s*-\s*YouTube\s*$/i, ''),
      tracks,
    };
  }

  async function fetchTrack(track) {
    if (!track || !Array.isArray(track.urls)) throw new Error('Invalid YouTube caption track.');
    let lastError;
    for (const candidate of track.urls) {
      const url = safeUrl(candidate);
      if (!url) continue;
      try {
        const response = await fetch(url, { credentials: 'include' });
        if (!response.ok) throw new Error(`YouTube returned HTTP ${response.status}.`);
        const text = await response.text();
        if (!text.trim()) throw new Error('YouTube returned an empty caption file.');
        return text;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('The selected caption track could not be downloaded.');
  }

  async function handleRequest(message) {
    if (message.action === 'GET_TRACKS') return await discoverTracks();
    if (message.action === 'FETCH_TRACK') return { text: await fetchTrack(message.track) };
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
