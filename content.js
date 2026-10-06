(() => {
  'use strict';
  if (globalThis.__captionFlowApi) return;

  const subtitles = globalThis.CaptionFlowSubtitles;
  if (!subtitles) throw new Error('CaptionFlow subtitle utilities were not loaded.');

  // Site adapter: which streaming site this frame belongs to. Crunchyroll's
  // player lives in an iframe on static.crunchyroll.com, so that frame (not
  // the top page) owns the video, the toolbar button, and track discovery.
  const SITE = (() => {
    const host = location.hostname.toLowerCase();
    if (/(^|\.)youtube(?:-nocookie)?\.com$/.test(host) || host === 'youtu.be') return 'youtube';
    if (/(^|\.)crunchyroll\.com$/.test(host)) return 'crunchyroll';
    return 'generic';
  })();
  const SITE_NAME = SITE === 'youtube' ? 'YouTube' : SITE === 'crunchyroll' ? 'Crunchyroll' : 'This site';
  const SITE_SUPPORTS_TRACKS = SITE === 'youtube' || SITE === 'crunchyroll';

  const STORAGE_KEY = 'captionflow.style.v1';
  const DEFAULT_STYLE = {
    enabled: true,
    fontSize: 32,
    offsetMs: 0,
    position: 18,
    preset: 'clean',
    textColor: '#ffffff',
    backgroundEnabled: true,
    backgroundOpacity: 0.72,
    fontWeight: 700,
  };

  const state = {
    video: null,
    cues: [],
    activeText: '',
    sourceName: '',
    sourceType: '',
    youtube: null,
    style: { ...DEFAULT_STYLE },
    overlay: null,
    toolbarVisible: false,
    lastRectUpdate: 0,
    lastVideoSearch: 0,
    lastYoutubeVideoId: '',
    sidebar: null,
    sidebarOpen: false,
    lastButtonCheck: 0,
    sbTracks: [],
    sbSelected: '',
    sbFormat: 'srt',
  };

  const pendingPageRequests = new Map();
  let requestCounter = 0;

  function requestPage(action, payload = {}, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      const requestId = `cf-${Date.now()}-${++requestCounter}`;
      const timeout = setTimeout(() => {
        pendingPageRequests.delete(requestId);
        reject(new Error(`${SITE_NAME} did not respond. Refresh the page and try again.`));
      }, timeoutMs);
      pendingPageRequests.set(requestId, { resolve, reject, timeout });
      window.postMessage({ source: 'captionflow-extension', requestId, action, ...payload }, '*');
    });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== 'captionflow-page') return;
    const pending = pendingPageRequests.get(event.data.requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    pendingPageRequests.delete(event.data.requestId);
    if (event.data.ok) pending.resolve(event.data.payload);
    else pending.reject(new Error(event.data.error || 'YouTube request failed.'));
  });

  function visibleArea(video) {
    const rect = video.getBoundingClientRect();
    if (rect.width < 160 || rect.height < 90) return 0;
    const style = getComputedStyle(video);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return 0;
    const width = Math.max(0, Math.min(innerWidth, rect.right) - Math.max(0, rect.left));
    const height = Math.max(0, Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top));
    return width * height;
  }

  function findBestVideo() {
    const candidates = [...document.querySelectorAll('video')]
      .map((video) => ({ video, area: visibleArea(video) }))
      .filter((item) => item.area > 0)
      .sort((a, b) => {
        const playingA = !a.video.paused && !a.video.ended ? 1 : 0;
        const playingB = !b.video.paused && !b.video.ended ? 1 : 0;
        return playingB - playingA || b.area - a.area;
      });
    return candidates[0]?.video || null;
  }


  function currentYoutubeVideoId() {
    const pathMatch = location.pathname.match(/^\/(?:shorts|embed)\/([^/?]+)/);
    return pathMatch?.[1] || new URLSearchParams(location.search).get('v') || '';
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return '';
    const total = Math.floor(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  }

  function cleanTitle() {
    if (SITE === 'youtube') {
      const youtubeTitle = document.querySelector('h1.ytd-watch-metadata yt-formatted-string, #title h1 yt-formatted-string')?.textContent?.trim();
      return youtubeTitle || document.title.replace(/\s*-\s*YouTube\s*$/i, '').trim() || 'Current video';
    }
    if (SITE === 'crunchyroll') {
      const heading = document.querySelector('.erc-current-media-info h1, h1[class*="title"], h4[class*="title"]')?.textContent?.trim();
      return heading || document.title.replace(/\s*[-|]\s*(Watch on )?Crunchyroll\s*$/i, '').trim() || 'Current video';
    }
    return document.title.trim() || 'Current video';
  }

  function videoInfo() {
    const video = state.video && document.contains(state.video) ? state.video : findBestVideo();
    if (video && video !== state.video) attachVideo(video);
    const rect = video?.getBoundingClientRect();
    return {
      found: Boolean(video),
      title: cleanTitle(),
      duration: formatDuration(video?.duration),
      durationSeconds: Number.isFinite(video?.duration) ? video.duration : 0,
      width: Math.round(video?.videoWidth || rect?.width || 0),
      height: Math.round(video?.videoHeight || rect?.height || 0),
      area: Math.round((rect?.width || 0) * (rect?.height || 0)),
      pageUrl: location.href,
      hostname: location.hostname,
      isYouTube: SITE === 'youtube',
      isCrunchyroll: SITE === 'crunchyroll',
      siteName: SITE_NAME,
      supportsTracks: SITE_SUPPORTS_TRACKS,
      playing: video ? !video.paused && !video.ended : false,
    };
  }

  function overlayMarkup() {
    return `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        .root {
          position: absolute; inset: 0; pointer-events: none; overflow: hidden;
          font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          color: white;
        }
        .subtitle-wrap {
          position: absolute; left: 6%; right: 6%; bottom: var(--cf-position, 18%);
          display: flex; justify-content: center; text-align: center; pointer-events: none;
          transition: bottom 140ms ease, opacity 120ms ease;
        }
        .subtitle {
          display: inline; max-width: 100%; white-space: pre-line; overflow-wrap: anywhere;
          color: var(--cf-color, #fff); font-size: var(--cf-size, 32px); font-weight: var(--cf-weight, 700);
          line-height: 1.32; letter-spacing: -0.015em;
          padding: .1em .34em .15em; border-radius: .22em;
          background: rgba(3, 7, 15, var(--cf-bg-opacity, .72));
          box-decoration-break: clone; -webkit-box-decoration-break: clone;
          text-shadow: 0 2px 4px rgba(0,0,0,.92), 0 0 1px rgba(0,0,0,.9);
          box-shadow: 0 3px 12px rgba(0,0,0,.12);
        }
        .root.toolbar-visible .subtitle-wrap { bottom: max(var(--cf-position, 18%), 155px); }
        .root.more-open .subtitle-wrap { bottom: max(var(--cf-position, 18%), 300px); }
        .root[data-bg="off"] .subtitle { background: transparent; box-shadow: none; }
        .root[data-preset="outline"] .subtitle {
          background: transparent; box-shadow: none;
          text-shadow: -2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000, 0 3px 8px #000;
        }
        .root[data-preset="soft"] .subtitle {
          background: rgba(4, 9, 18, .46); font-weight: 650; text-shadow: 0 2px 8px #000;
        }
        .toolbar-shell {
          position: absolute; left: 50%; bottom: 68px; transform: translate(-50%, 10px);
          width: min(760px, calc(100% - 28px)); pointer-events: none; opacity: 0;
          transition: opacity 150ms ease, transform 150ms ease;
        }
        .toolbar-shell.visible { opacity: 1; transform: translate(-50%, 0); pointer-events: auto; }
        .toolbar {
          display: grid; grid-template-columns: auto auto auto auto 1fr auto; gap: 8px; align-items: stretch;
          padding: 8px; border: 1px solid rgba(255,255,255,.14); border-radius: 18px;
          background: rgba(8, 13, 22, .94); box-shadow: 0 18px 45px rgba(0,0,0,.38);
          backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px);
        }
        button { font: inherit; }
        .tool, .step {
          border: 1px solid transparent; border-radius: 11px; color: #eaf0f7; background: transparent;
          cursor: pointer; transition: background 120ms ease, border-color 120ms ease;
        }
        .tool:hover, .step:hover { background: rgba(255,255,255,.07); border-color: rgba(255,255,255,.08); }
        .tool.active { background: #0b69b7; color: #fff; }
        .tool { min-width: 56px; padding: 7px 10px; display: grid; place-items: center; gap: 2px; }
        .tool strong { font-size: 12px; line-height: 1; }
        .tool small { font-size: 9px; color: #9ba8ba; }
        .tool.active small { color: rgba(255,255,255,.82); }
        .group {
          min-width: 138px; padding: 5px 7px; border-left: 1px solid rgba(255,255,255,.1);
          display: grid; grid-template-columns: 35px 1fr 35px; gap: 4px; align-items: center;
        }
        .group-label { grid-column: 1 / -1; text-align: center; color: #9ba8ba; font-size: 9px; line-height: 1; text-transform: uppercase; letter-spacing: .08em; }
        .step { height: 28px; padding: 0; font-size: 17px; }
        .value { color: #fff; font-size: 11px; font-weight: 700; text-align: center; white-space: nowrap; }
        .spacer { min-width: 1px; }
        .more-panel {
          margin: 8px auto 0; width: min(520px, calc(100% - 18px)); padding: 14px;
          border: 1px solid rgba(255,255,255,.13); border-radius: 16px;
          background: rgba(8, 13, 22, .97); box-shadow: 0 20px 48px rgba(0,0,0,.4);
          display: none; color: #edf2f8;
        }
        .more-panel.open { display: grid; gap: 13px; }
        .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
        .row > span { font-size: 12px; font-weight: 650; }
        .presets, .colors { display: flex; gap: 7px; }
        .chip {
          border: 1px solid rgba(255,255,255,.12); border-radius: 10px; background: rgba(255,255,255,.035);
          color: #cbd5e2; padding: 7px 10px; font-size: 10px; font-weight: 700; cursor: pointer;
        }
        .chip.active { border-color: #2c8ed5; background: rgba(11,105,183,.3); color: #fff; }
        .color {
          width: 27px; height: 27px; border-radius: 9px; border: 2px solid transparent; cursor: pointer;
          box-shadow: inset 0 0 0 1px rgba(255,255,255,.22);
        }
        .color.active { border-color: #2c8ed5; }
        .range { width: 210px; accent-color: #0b69b7; }
        @media (max-width: 720px) {
          .toolbar { grid-template-columns: auto 1fr 1fr auto; }
          .position-group { display: none; }
          .toolbar-shell { bottom: 54px; }
          .subtitle-wrap { left: 4%; right: 4%; }
        }
        @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
      </style>
      <div class="root" data-bg="on" data-preset="clean">
        <div class="subtitle-wrap"><span class="subtitle"></span></div>
        <div class="toolbar-shell">
          <div class="toolbar">
            <button class="tool cc active" title="Show or hide subtitles"><strong>CC</strong><small>On</small></button>
            <div class="group">
              <span class="group-label">Font size</span>
              <button class="step size-down" title="Decrease font size">−</button>
              <span class="value size-value">32px</span>
              <button class="step size-up" title="Increase font size">+</button>
            </div>
            <div class="group">
              <span class="group-label">Sync</span>
              <button class="step offset-down" title="Show captions earlier">−</button>
              <span class="value offset-value">0.0s</span>
              <button class="step offset-up" title="Show captions later">+</button>
            </div>
            <div class="group position-group">
              <span class="group-label">Position</span>
              <button class="step position-down" title="Move subtitles down">↓</button>
              <span class="value position-value">18%</span>
              <button class="step position-up" title="Move subtitles up">↑</button>
            </div>
            <span class="spacer"></span>
            <button class="tool more" title="More subtitle settings"><strong>•••</strong><small>More</small></button>
          </div>
          <div class="more-panel">
            <div class="row"><span>Style</span><div class="presets"><button class="chip" data-preset="clean">Clean</button><button class="chip" data-preset="soft">Soft</button><button class="chip" data-preset="outline">Outline</button></div></div>
            <div class="row"><span>Background opacity</span><input class="range opacity-range" type="range" min="0" max="95" value="72"></div>
            <div class="row"><span>Text colour</span><div class="colors"><button class="color" data-color="#ffffff" style="background:#fff"></button><button class="color" data-color="#caf0f8" style="background:#caf0f8"></button><button class="color" data-color="#ffe08a" style="background:#ffe08a"></button></div></div>
          </div>
        </div>
      </div>`;
  }

  function ensureOverlay() {
    if (state.overlay?.host?.isConnected) return state.overlay;
    const host = document.createElement('div');
    host.id = 'captionflow-overlay-host';
    Object.assign(host.style, {
      position: 'fixed', left: '0', top: '0', width: '0', height: '0', zIndex: '2147483647',
      pointerEvents: 'none', display: 'none', margin: '0', padding: '0', border: '0',
    });
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = overlayMarkup();
    (document.fullscreenElement && document.fullscreenElement.tagName !== 'VIDEO' ? document.fullscreenElement : document.documentElement).appendChild(host);

    const overlay = {
      host,
      shadow,
      root: shadow.querySelector('.root'),
      subtitle: shadow.querySelector('.subtitle'),
      toolbarShell: shadow.querySelector('.toolbar-shell'),
      morePanel: shadow.querySelector('.more-panel'),
    };
    state.overlay = overlay;

    const by = (selector) => shadow.querySelector(selector);
    by('.cc').addEventListener('click', () => updateStyle({ enabled: !state.style.enabled }));
    by('.size-down').addEventListener('click', () => updateStyle({ fontSize: state.style.fontSize - 2 }));
    by('.size-up').addEventListener('click', () => updateStyle({ fontSize: state.style.fontSize + 2 }));
    by('.offset-down').addEventListener('click', () => updateStyle({ offsetMs: state.style.offsetMs - 100 }));
    by('.offset-up').addEventListener('click', () => updateStyle({ offsetMs: state.style.offsetMs + 100 }));
    by('.position-down').addEventListener('click', () => updateStyle({ position: state.style.position - 2 }));
    by('.position-up').addEventListener('click', () => updateStyle({ position: state.style.position + 2 }));
    by('.more').addEventListener('click', () => {
      const open = overlay.morePanel.classList.toggle('open');
      overlay.root.classList.toggle('more-open', open);
    });
    shadow.querySelectorAll('[data-preset]').forEach((button) => button.addEventListener('click', () => updateStyle({ preset: button.dataset.preset })));
    shadow.querySelectorAll('[data-color]').forEach((button) => button.addEventListener('click', () => updateStyle({ textColor: button.dataset.color })));
    by('.opacity-range').addEventListener('input', (event) => updateStyle({ backgroundOpacity: Number(event.target.value) / 100, backgroundEnabled: Number(event.target.value) > 0 }));
    applyStyle();
    return overlay;
  }

  function mountHostForFullscreen() {
    if (!state.overlay) return;
    const fullscreen = document.fullscreenElement;
    const parent = fullscreen && fullscreen.tagName !== 'VIDEO' ? fullscreen : document.documentElement;
    if (state.overlay.host.parentElement !== parent) parent.appendChild(state.overlay.host);
    updateLayout(true);
  }

  document.addEventListener('fullscreenchange', mountHostForFullscreen);

  function clampStyle(next) {
    return {
      ...next,
      fontSize: Math.min(72, Math.max(16, Number(next.fontSize) || DEFAULT_STYLE.fontSize)),
      offsetMs: Math.min(30000, Math.max(-30000, Number(next.offsetMs) || 0)),
      position: Math.min(36, Math.max(6, Number(next.position) || DEFAULT_STYLE.position)),
      backgroundOpacity: Math.min(0.95, Math.max(0, Number(next.backgroundOpacity) || 0)),
      preset: ['clean', 'soft', 'outline'].includes(next.preset) ? next.preset : 'clean',
      textColor: /^#[0-9a-f]{6}$/i.test(next.textColor) ? next.textColor : '#ffffff',
      enabled: Boolean(next.enabled),
      backgroundEnabled: Boolean(next.backgroundEnabled),
    };
  }

  async function updateStyle(partial, persist = true) {
    state.style = clampStyle({ ...state.style, ...partial });
    applyStyle();
    if (persist) await chrome.storage.local.set({ [STORAGE_KEY]: state.style });
    return state.style;
  }

  function applyStyle() {
    const overlay = ensureOverlay();
    const style = state.style;
    overlay.root.style.setProperty('--cf-size', `${style.fontSize}px`);
    overlay.root.style.setProperty('--cf-position', `${style.position}%`);
    overlay.root.style.setProperty('--cf-color', style.textColor);
    overlay.root.style.setProperty('--cf-weight', String(style.fontWeight || 700));
    overlay.root.style.setProperty('--cf-bg-opacity', String(style.backgroundOpacity));
    overlay.root.dataset.bg = style.backgroundEnabled ? 'on' : 'off';
    overlay.root.dataset.preset = style.preset;
    overlay.subtitle.style.opacity = style.enabled ? '1' : '0';
    const cc = overlay.shadow.querySelector('.cc');
    cc.classList.toggle('active', style.enabled);
    cc.querySelector('small').textContent = style.enabled ? 'On' : 'Off';
    overlay.shadow.querySelector('.size-value').textContent = `${style.fontSize}px`;
    overlay.shadow.querySelector('.offset-value').textContent = `${style.offsetMs >= 0 ? '+' : ''}${(style.offsetMs / 1000).toFixed(1)}s`;
    overlay.shadow.querySelector('.position-value').textContent = `${style.position}%`;
    overlay.shadow.querySelector('.opacity-range').value = String(Math.round(style.backgroundOpacity * 100));
    overlay.shadow.querySelectorAll('[data-preset]').forEach((button) => button.classList.toggle('active', button.dataset.preset === style.preset));
    overlay.shadow.querySelectorAll('[data-color]').forEach((button) => button.classList.toggle('active', button.dataset.color.toLowerCase() === style.textColor.toLowerCase()));
  }

  function attachVideo(video) {
    if (!video || state.video === video) return;
    state.video = video;
    ensureOverlay();
    updateLayout(true);
  }

  function updateLayout(force = false) {
    const video = state.video;
    const overlay = ensureOverlay();
    if (!video || !document.contains(video)) {
      overlay.host.style.display = 'none';
      return;
    }
    const now = performance.now();
    if (!force && now - state.lastRectUpdate < 90) return;
    state.lastRectUpdate = now;
    const rect = video.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 70 || rect.bottom < 0 || rect.top > innerHeight) {
      overlay.host.style.display = 'none';
      return;
    }
    overlay.host.style.display = 'block';
    overlay.host.style.left = `${Math.round(rect.left)}px`;
    overlay.host.style.top = `${Math.round(rect.top)}px`;
    overlay.host.style.width = `${Math.round(rect.width)}px`;
    overlay.host.style.height = `${Math.round(rect.height)}px`;
  }

  function showToolbar() {
    const overlay = ensureOverlay();
    state.toolbarVisible = true;
    overlay.toolbarShell.classList.add('visible');
    overlay.root.classList.add('toolbar-visible');
    markButtonsActive(true);
  }

  function hideToolbar() {
    state.toolbarVisible = false;
    markButtonsActive(false);
    if (!state.overlay) return;
    state.overlay.morePanel.classList.remove('open');
    state.overlay.root.classList.remove('more-open');
    state.overlay.toolbarShell.classList.remove('visible');
    state.overlay.root.classList.remove('toolbar-visible');
  }

  function toggleToolbar() { state.toolbarVisible ? hideToolbar() : showToolbar(); }

  function setCues(cues, sourceName, sourceType) {
    state.cues = subtitles.finalizeCues(cues);
    state.sourceName = sourceName;
    state.sourceType = sourceType;
    state.activeText = '';
    ensureOverlay();
    return state.cues.length;
  }

  async function siteTracks(refresh = false) {
    if (!SITE_SUPPORTS_TRACKS) throw new Error('Caption discovery works on YouTube and Crunchyroll. Local subtitle files work on any video.');
    if (SITE === 'youtube') {
      const videoId = currentYoutubeVideoId();
      if (!refresh && state.youtube?.tracks?.length && state.youtube.videoId === videoId) return state.youtube;
    } else if (!refresh && state.youtube?.tracks?.length) {
      // Crunchyroll reloads the player frame per episode, so a cached list
      // always belongs to the current video.
      return state.youtube;
    }
    const data = await requestPage('GET_TRACKS', {}, 16000);
    state.youtube = data;
    if (SITE === 'youtube') state.lastYoutubeVideoId = data.videoId || currentYoutubeVideoId();
    return data;
  }

  async function fetchSiteCues(trackId) {
    const data = await siteTracks(false);
    const track = data.tracks.find((item) => item.id === trackId);
    if (!track) throw new Error('The selected caption track is no longer available. Refresh the list.');
    const result = await requestPage('FETCH_TRACK', { track }, 18000);
    const cues = SITE === 'youtube'
      ? subtitles.parseYoutubeSrv3(result.text)
      : subtitles.parseSubtitle(result.text, `captions.${result.format || track.format || 'ass'}`);
    if (!cues.length) throw new Error('The selected caption file did not contain readable cues.');
    return { cues, track, title: data.title || cleanTitle() };
  }

  function safeFilename(value) {
    return String(value || 'captions').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 140) || 'captions';
  }

  async function handleMessage(message) {
    switch (message?.type) {
      case 'CF_GET_STATE':
        return { ok: true, info: videoInfo(), style: state.style, sourceName: state.sourceName, sourceType: state.sourceType, cueCount: state.cues.length };
      case 'CF_GET_YOUTUBE_TRACKS': {
        const data = await siteTracks(Boolean(message.refresh));
        return { ok: true, title: data.title, videoId: data.videoId, tracks: data.tracks.map(({ urls, key, ...track }) => track) };
      }
      case 'CF_DISPLAY_YOUTUBE_TRACK': {
        const { cues, track } = await fetchSiteCues(message.trackId);
        const count = setCues(cues, track.label, SITE);
        return { ok: true, count };
      }
      case 'CF_EXTRACT_YOUTUBE_TRACK': {
        const { cues, track, title } = await fetchSiteCues(message.trackId);
        const format = message.format === 'vtt' ? 'vtt' : 'srt';
        return {
          ok: true,
          filename: `${safeFilename(title)} - ${safeFilename(track.label)}.${format}`,
          mime: format === 'vtt' ? 'text/vtt' : 'application/x-subrip',
          text: subtitles.serialize(cues, format),
          count: cues.length,
        };
      }
      case 'CF_LOAD_LOCAL': {
        const cues = subtitles.parseSubtitle(message.text, message.name);
        if (!cues.length) throw new Error('No readable subtitle cues were found in that file.');
        const count = setCues(cues, message.name, 'local');
        return { ok: true, count };
      }
      case 'CF_UPDATE_STYLE':
        return { ok: true, style: await updateStyle(message.style || {}) };
      case 'CF_CLEAR':
        setCues([], '', '');
        return { ok: true };
      case 'CF_TOGGLE_SIDEBAR': {
        // The toggle is broadcast to every frame; only the frame that owns
        // the playing video should answer. On Crunchyroll that is the player
        // iframe, never the top page.
        const info = videoInfo();
        const isTop = window.top === window;
        if (!isTop && (!info.found || info.width < 320)) return { ok: true, skipped: true };
        if (isTop && SITE === 'crunchyroll' && !info.found) return { ok: true, skipped: true };
        toggleSidebar();
        return { ok: true };
      }
      default:
        throw new Error('CaptionFlow received an unknown command.');
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    Promise.resolve(handleMessage(message))
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  });

  globalThis.__captionFlowApi = { getVideoInfo: videoInfo };

  chrome.storage.local.get(STORAGE_KEY).then((stored) => {
    state.style = clampStyle({ ...DEFAULT_STYLE, ...(stored?.[STORAGE_KEY] || {}) });
    applyStyle();
  }).catch(() => applyStyle());

  /* ---------- Player toolbar button + sidebar ---------- */

  function cfLogoSvg(size) {
    return `<svg viewBox="0 0 36 36" width="${size}" height="${size}" aria-hidden="true">`
      + `<g transform="translate(4,4) scale(0.875)" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">`
      + `<path d="M5 9c5-5 10 5 16 0 2-1 4-3 6-5M5 16c5-5 10 5 16 0 2-1 4-3 6-5M5 23c5-5 10 5 16 0 2-1 4-3 6-5"/>`
      + `</g></svg>`;
  }

  function injectPageButtonStyleOnce() {
    if (document.getElementById('cf-player-button-style')) return;
    const style = document.createElement('style');
    style.id = 'cf-player-button-style';
    style.textContent = `
      .cf-player-button {
        display: inline-flex !important; align-items: center; justify-content: center;
        width: 48px; height: 100%; min-width: 40px; padding: 0; margin: 0;
        border: 0; background: transparent; color: #fff; opacity: .9;
        cursor: pointer; vertical-align: top; box-sizing: border-box; flex: 0 0 auto;
      }
      .cf-player-button:hover { opacity: 1; }
      .cf-player-button svg { width: 24px; height: 24px; display: block; pointer-events: none; }
      .cf-player-button.cf-active { color: #3ea6ff; }
      .cf-cr-button { width: 44px; height: 44px; border-radius: 6px; }
      .cf-cr-button:hover { background: rgba(255,255,255,.12); }
      .cf-cr-button.cf-active { color: #f47521; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function directChildOf(node, root) {
    let current = node;
    while (current && current !== root) {
      if (current.parentNode === root) return current;
      current = current.parentNode;
    }
    return null;
  }

  function addPlayerButton({ bar, reference, className }) {
    if (!bar) return;
    if (bar.querySelector('.cf-player-button')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.title = 'CaptionFlow subtitles';
    btn.setAttribute('aria-label', 'CaptionFlow subtitles');
    btn.innerHTML = cfLogoSvg('24');
    btn.addEventListener('click', (event) => { event.stopPropagation(); event.preventDefault(); toggleToolbar(); });
    const referenceNode = reference ? directChildOf(reference, bar) : null;
    bar.insertBefore(btn, referenceNode || bar.firstChild || null);
    if (state.toolbarVisible) btn.classList.add('cf-active');
  }

  // Where this site's player control bar lives and how our button should
  // dress to match its native controls.
  function siteControlContainers() {
    if (SITE === 'youtube') {
      return [...document.querySelectorAll('.ytp-right-controls')].map((bar) => ({
        bar,
        reference: bar.querySelector('.ytp-settings-button'),
        className: 'ytp-button cf-player-button',
      }));
    }
    if (SITE === 'crunchyroll') {
      // The vilos player marks controls with data-testid attributes; probe a
      // few generations of them and give up gracefully (float button) if the
      // player markup changes again.
      const settings = document.querySelector(
        '[data-testid="vilos-settings_button"], [data-testid="vilos-subtitles_button"], #settingsControl, [data-testid="vilos-fullscreen_button"]'
      );
      const bar = settings?.parentElement || null;
      return bar ? [{ bar, reference: settings, className: 'cf-player-button cf-cr-button' }] : [];
    }
    return [];
  }

  function ensureFloatButton() {
    const overlay = ensureOverlay();
    if (overlay.root.querySelector('.cf-float-button')) return;
    const btn = document.createElement('button');
    btn.className = 'cf-float-button';
    btn.title = 'CaptionFlow subtitles';
    btn.innerHTML = cfLogoSvg('22');
    Object.assign(btn.style, {
      position: 'absolute', top: '12px', right: '12px', width: '40px', height: '40px',
      borderRadius: '50%', display: 'grid', placeItems: 'center', color: '#fff',
      background: 'rgba(8,13,22,.82)', border: '1px solid rgba(255,255,255,.18)',
      cursor: 'pointer', pointerEvents: 'auto', zIndex: '5', padding: '0',
    });
    btn.addEventListener('click', (event) => { event.stopPropagation(); toggleToolbar(); });
    overlay.root.appendChild(btn);
    if (state.toolbarVisible) btn.style.background = '#0b69b7';
  }

  function removeFloatButton() {
    state.overlay?.root.querySelector('.cf-float-button')?.remove();
  }

  function ensureControlButton() {
    injectPageButtonStyleOnce();
    const containers = siteControlContainers();
    if (containers.length) {
      containers.forEach(addPlayerButton);
      removeFloatButton();
      return;
    }
    if (state.video && document.contains(state.video)) ensureFloatButton();
    else removeFloatButton();
  }

  function markButtonsActive(active) {
    document.querySelectorAll('.cf-player-button').forEach((btn) => btn.classList.toggle('cf-active', active));
    const floatBtn = state.overlay?.root.querySelector('.cf-float-button');
    if (floatBtn) floatBtn.style.background = active ? '#0b69b7' : 'rgba(8,13,22,.82)';
  }

  function sidebarMarkup() {
    return `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
        .panel {
          position: fixed; top: 0; right: 0; height: 100%; width: 360px; max-width: 92vw;
          transform: translateX(100%); transition: transform 220ms cubic-bezier(.4,0,.2,1);
          background: linear-gradient(180deg, #0a0f18 0, #070a10 100%); color: #f7f9fc;
          border-left: 1px solid rgba(255,255,255,.1); box-shadow: -18px 0 50px rgba(0,0,0,.45);
          display: flex; flex-direction: column; pointer-events: auto; overflow: hidden;
        }
        .panel.open { transform: translateX(0); }
        .head { display: flex; align-items: center; gap: 11px; padding: 16px 16px 14px; border-bottom: 1px solid rgba(255,255,255,.08); }
        .mark { width: 36px; height: 36px; display: grid; place-items: center; border-radius: 11px; background: #0d1b2d; border: 1px solid #263a54; color: #2995e5; flex: none; }
        .mark svg { width: 24px; height: 24px; }
        .head h1 { margin: 0; font-size: 15px; letter-spacing: -.01em; }
        .head p { margin: 2px 0 0; font-size: 10px; color: #9aa6b7; }
        .close { margin-left: auto; width: 30px; height: 30px; border: 0; border-radius: 9px; background: rgba(255,255,255,.05); color: #cdd6e4; font-size: 18px; cursor: pointer; }
        .close:hover { background: rgba(255,255,255,.1); }
        .body { flex: 1; overflow-y: auto; padding: 14px 16px 18px; display: flex; flex-direction: column; gap: 16px; }
        .section-title { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
        .section-title strong { font-size: 12px; }
        .section-title small { display: block; color: #9aa6b7; font-size: 10px; margin-top: 2px; }
        .quiet { border: 1px solid rgba(255,255,255,.12); background: transparent; color: #cbd5e2; border-radius: 8px; padding: 5px 10px; font-size: 11px; cursor: pointer; }
        .quiet:hover { background: rgba(255,255,255,.06); }
        .tracks { display: flex; flex-direction: column; gap: 7px; }
        .track { display: flex; align-items: center; gap: 10px; text-align: left; width: 100%; padding: 10px 11px; border-radius: 11px; border: 1px solid rgba(255,255,255,.09); background: rgba(255,255,255,.025); color: inherit; cursor: pointer; }
        .track.selected { border-color: #2c8ed5; background: rgba(11,105,183,.22); }
        .radio { width: 15px; height: 15px; border-radius: 50%; border: 2px solid #5a657b; flex: none; }
        .track.selected .radio { border-color: #3ea6ff; box-shadow: inset 0 0 0 3px #3ea6ff; }
        .track-copy strong { font-size: 12px; display: block; }
        .track-copy small { font-size: 10px; color: #9aa6b7; }
        .badge { margin-left: auto; font-size: 9px; font-weight: 700; padding: 3px 7px; border-radius: 999px; background: rgba(255,255,255,.08); }
        .empty { font-size: 11px; color: #9aa6b7; padding: 12px; border: 1px dashed rgba(255,255,255,.14); border-radius: 11px; }
        .primary { width: 100%; display: flex; gap: 10px; align-items: center; justify-content: center; padding: 11px; margin-top: 11px; border: 0; border-radius: 12px; background: #0b69b7; color: #fff; font-size: 12px; font-weight: 700; cursor: pointer; }
        .primary:hover { background: #0d78ce; }
        .primary:disabled { opacity: .45; cursor: not-allowed; }
        .file { display: flex; align-items: center; gap: 10px; padding: 11px; border: 1px solid rgba(255,255,255,.1); border-radius: 11px; background: rgba(255,255,255,.025); }
        .file input { display: none; }
        .file span { font-size: 11px; color: #cbd5e2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .file button { margin-left: auto; flex: none; }
        .divider { height: 1px; background: rgba(255,255,255,.08); }
        .chips { display: flex; gap: 7px; }
        .chip { flex: 1; border: 1px solid rgba(255,255,255,.12); border-radius: 9px; background: rgba(255,255,255,.03); color: #cbd5e2; padding: 7px; font-size: 10px; font-weight: 700; cursor: pointer; }
        .chip.active { border-color: #2c8ed5; background: rgba(11,105,183,.3); color: #fff; }
        .status { padding: 9px 12px; font-size: 11px; color: #9aa6b7; border-top: 1px solid rgba(255,255,255,.08); }
        .status[data-kind="error"] { color: #ff8a94; }
        .status[data-kind="success"] { color: #4fd6a0; }
        @media (prefers-reduced-motion: reduce) { .panel { transition: none; } }
      </style>
      <div class="panel">
        <div class="head">
          <span class="mark">${cfLogoSvg('24')}</span>
          <div><h1>CaptionFlow</h1><p>Subtitles for this video</p></div>
          <button class="close" title="Close">×</button>
        </div>
        <div class="body">
          <section>
            <div class="section-title">
              <div><strong class="sb-site-heading">Video captions</strong><small class="sb-track-summary">Detecting tracks…</small></div>
              <button class="quiet sb-refresh">Refresh</button>
            </div>
            <div class="tracks sb-track-list"></div>
            <button class="primary sb-display" disabled>Display selected captions</button>
          </section>
          <div class="divider"></div>
          <section>
            <div class="section-title"><div><strong>Local subtitle</strong><small>SRT, VTT, ASS or SSA</small></div></div>
            <label class="file">
              <input type="file" class="sb-file" accept=".srt,.vtt,.ass,.ssa">
              <span class="sb-file-label">No file chosen</span>
              <button type="button" class="quiet sb-browse">Browse</button>
            </label>
          </section>
          <div class="divider"></div>
          <section>
            <div class="section-title"><div><strong>Extract subtitles</strong><small>Save the selected track as a file</small></div></div>
            <div class="chips sb-format-chips">
              <button class="chip active" data-format="srt">SRT</button>
              <button class="chip" data-format="vtt">VTT</button>
            </div>
            <button class="primary sb-extract" disabled>Extract subtitles</button>
          </section>
        </div>
        <div class="status sb-status" data-kind="neutral">Ready.</div>
      </div>`;
  }

  function ensureSidebar() {
    if (state.sidebar?.host?.isConnected) return state.sidebar;
    const host = document.createElement('div');
    host.id = 'captionflow-sidebar-host';
    Object.assign(host.style, { position: 'fixed', top: '0', right: '0', width: '0', height: '0', zIndex: '2147483647' });
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = sidebarMarkup();
    (document.fullscreenElement && document.fullscreenElement.tagName !== 'VIDEO' ? document.fullscreenElement : document.documentElement).appendChild(host);

    const by = (selector) => shadow.querySelector(selector);
    const sidebar = { host, shadow, panel: by('.panel'), status: by('.sb-status') };
    state.sidebar = sidebar;

    by('.close').addEventListener('click', closeSidebar);
    by('.sb-refresh').addEventListener('click', () => sidebarLoadTracks(true));
    by('.sb-display').addEventListener('click', sidebarDisplay);
    by('.sb-browse').addEventListener('click', (event) => { event.preventDefault(); by('.sb-file').click(); });
    by('.sb-file').addEventListener('change', (event) => sidebarFile(event.target.files?.[0]));
    by('.sb-extract').addEventListener('click', sidebarExtract);
    shadow.querySelectorAll('[data-format]').forEach((button) => button.addEventListener('click', () => {
      state.sbFormat = button.dataset.format;
      shadow.querySelectorAll('[data-format]').forEach((item) => item.classList.toggle('active', item === button));
    }));

    return sidebar;
  }

  function mountSidebarForFullscreen() {
    if (!state.sidebar) return;
    const fullscreen = document.fullscreenElement;
    const parent = fullscreen && fullscreen.tagName !== 'VIDEO' ? fullscreen : document.documentElement;
    if (state.sidebar.host.parentElement !== parent) parent.appendChild(state.sidebar.host);
  }

  document.addEventListener('fullscreenchange', mountSidebarForFullscreen);

  function setSbStatus(message, kind = 'neutral') {
    const sidebar = state.sidebar;
    if (!sidebar) return;
    sidebar.status.textContent = message;
    sidebar.status.dataset.kind = kind;
  }

  function renderSidebarTracks() {
    const sidebar = ensureSidebar();
    const list = sidebar.shadow.querySelector('.sb-track-list');
    const summary = sidebar.shadow.querySelector('.sb-track-summary');
    const displayBtn = sidebar.shadow.querySelector('.sb-display');
    const extractBtn = sidebar.shadow.querySelector('.sb-extract');
    const heading = sidebar.shadow.querySelector('.sb-site-heading');
    if (heading) heading.textContent = SITE_SUPPORTS_TRACKS ? `${SITE_NAME} captions` : 'Video captions';
    list.replaceChildren();

    if (!SITE_SUPPORTS_TRACKS) {
      summary.textContent = 'Use a local subtitle file below.';
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Caption discovery is available on YouTube and Crunchyroll. Local subtitles work on any video.';
      list.append(empty);
      displayBtn.disabled = true;
      extractBtn.disabled = true;
      return;
    }
    if (!state.sbTracks.length) {
      summary.textContent = 'No caption tracks found.';
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'This video may have no captions yet. Start the video, then tap Refresh.';
      list.append(empty);
      displayBtn.disabled = true;
      extractBtn.disabled = true;
      return;
    }

    summary.textContent = `${state.sbTracks.length} track${state.sbTracks.length === 1 ? '' : 's'} available`;
    if (!state.sbTracks.some((track) => track.id === state.sbSelected)) state.sbSelected = state.sbTracks[0].id;

    for (const track of state.sbTracks) {
      const button = document.createElement('button');
      button.className = `track${track.id === state.sbSelected ? ' selected' : ''}`;
      const radio = document.createElement('span');
      radio.className = 'radio';
      const copy = document.createElement('span');
      copy.className = 'track-copy';
      const title = document.createElement('strong');
      title.textContent = track.label || track.language;
      const detail = document.createElement('small');
      const formatNote = track.format ? ` • ${String(track.format).toUpperCase()}` : '';
      detail.textContent = `${track.kind === 'auto' ? 'Auto-generated' : 'Creator-provided'} • ${String(track.language || '').toUpperCase()}${formatNote}`;
      copy.append(title, detail);
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = track.kind === 'auto' ? 'Auto' : 'CC';
      button.append(radio, copy, badge);
      button.addEventListener('click', () => { state.sbSelected = track.id; renderSidebarTracks(); });
      list.append(button);
    }
    displayBtn.disabled = false;
    extractBtn.disabled = false;
  }

  async function sidebarLoadTracks(refresh = false) {
    if (!SITE_SUPPORTS_TRACKS) { state.sbTracks = []; renderSidebarTracks(); return; }
    setSbStatus(refresh ? 'Refreshing captions…' : 'Detecting captions…', 'neutral');
    try {
      const data = await siteTracks(Boolean(refresh));
      state.sbTracks = data.tracks || [];
      renderSidebarTracks();
      setSbStatus(state.sbTracks.length ? 'Captions ready.' : 'No captions found.', state.sbTracks.length ? 'success' : 'neutral');
    } catch (error) {
      state.sbTracks = [];
      renderSidebarTracks();
      setSbStatus(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  async function sidebarDisplay() {
    if (!state.sbSelected) return;
    setSbStatus('Loading selected captions…', 'neutral');
    try {
      const { cues, track } = await fetchSiteCues(state.sbSelected);
      const count = setCues(cues, track.label, SITE);
      setSbStatus(`Showing ${count.toLocaleString()} cues.`, 'success');
    } catch (error) {
      setSbStatus(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  async function sidebarFile(file) {
    if (!file) return;
    if (file.size > 12 * 1024 * 1024) { setSbStatus('Choose a file smaller than 12 MB.', 'error'); return; }
    const sidebar = ensureSidebar();
    sidebar.shadow.querySelector('.sb-file-label').textContent = file.name;
    setSbStatus(`Loading ${file.name}…`, 'neutral');
    try {
      const text = await file.text();
      const cues = subtitles.parseSubtitle(text, file.name);
      if (!cues.length) throw new Error('No readable cues were found in that file.');
      const count = setCues(cues, file.name, 'local');
      setSbStatus(`${file.name} displaying (${count.toLocaleString()} cues).`, 'success');
    } catch (error) {
      setSbStatus(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  async function sidebarExtract() {
    if (!state.sbSelected) return;
    setSbStatus(`Extracting ${state.sbFormat.toUpperCase()} captions…`, 'neutral');
    try {
      const { cues, track, title } = await fetchSiteCues(state.sbSelected);
      const format = state.sbFormat === 'vtt' ? 'vtt' : 'srt';
      const filename = `${safeFilename(title)} - ${safeFilename(track.label)}.${format}`;
      const mime = format === 'vtt' ? 'text/vtt' : 'application/x-subrip';
      const text = subtitles.serialize(cues, format);
      downloadFile(filename, text, mime);
      setSbStatus(`${filename} downloaded (${cues.length.toLocaleString()} cues).`, 'success');
    } catch (error) {
      setSbStatus(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  function downloadFile(filename, text, mime) {
    const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function toggleSidebar() { state.sidebarOpen ? closeSidebar() : openSidebar(); }

  function openSidebar() {
    const sidebar = ensureSidebar();
    mountSidebarForFullscreen();
    requestAnimationFrame(() => sidebar.panel.classList.add('open'));
    state.sidebarOpen = true;
    sidebarLoadTracks(false);
  }

  function closeSidebar() {
    state.sidebarOpen = false;
    state.sidebar?.panel.classList.remove('open');
  }

  function frame() {
    const now = performance.now();
    if (now - state.lastButtonCheck > 800) {
      state.lastButtonCheck = now;
      try { ensureControlButton(); } catch { /* player not ready yet */ }
    }
    if (/(^|\.)youtube(?:-nocookie)?\.com$/i.test(location.hostname)) {
      const currentId = currentYoutubeVideoId();
      if (state.lastYoutubeVideoId && currentId && currentId !== state.lastYoutubeVideoId) {
        state.youtube = null;
        state.lastYoutubeVideoId = currentId;
        if (state.sourceType === 'youtube') setCues([], '', '');
      } else if (!state.lastYoutubeVideoId && currentId) {
        state.lastYoutubeVideoId = currentId;
      }
    }
    if (!state.video || !document.contains(state.video) || now - state.lastVideoSearch > 1200) {
      state.lastVideoSearch = now;
      const best = findBestVideo();
      if (best) attachVideo(best);
    }
    updateLayout();
    if (state.video && state.cues.length) {
      const current = state.video.currentTime * 1000 + state.style.offsetMs;
      const text = state.style.enabled ? subtitles.activeTextAt(state.cues, current) : '';
      if (text !== state.activeText) {
        state.activeText = text;
        state.overlay.subtitle.textContent = text;
        state.overlay.subtitle.parentElement.style.opacity = text ? '1' : '0';
      }
    } else if (state.activeText) {
      state.activeText = '';
      state.overlay.subtitle.textContent = '';
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
