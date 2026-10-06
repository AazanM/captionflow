'use strict';

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  try {
    // Broadcast to every frame: on sites whose player lives inside an iframe
    // (Crunchyroll), the frame that owns the video answers the toggle and
    // the other frames decline it.
    await chrome.tabs.sendMessage(tab.id, { type: 'CF_TOGGLE_SIDEBAR' });
  } catch (error) {
    // No CaptionFlow content script is active on this page (e.g. a chrome:// page,
    // the Chrome Web Store, or a tab that hasn't been refreshed since install).
    console.warn('[CaptionFlow] Could not reach this page:', error?.message || error);
  }
});
