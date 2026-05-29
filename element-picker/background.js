// Handle extension icon click
const pendingToursByTab = new Map();
const breakOnLoadTabs = new Map();
const CODEX_TRACE_URL = 'http://127.0.0.1:43117/traces';

async function injectPicker(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['vibe-page-probe.js'],
      world: 'MAIN'
    });
  } catch (error) {
    console.warn('Unable to inject Vibe Debugger page probe:', error);
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['picker.js']
  });

  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ['picker.css']
  });
}

// Ask an already-running QA Bridge in this tab to close itself. Returns true
// when an active session handled the click, so the toolbar icon toggles the
// bridge on and off instead of silently doing nothing on the second click.
async function closeExistingSession(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: 'ELEMENT_PICKER_TOGGLE',
    });
    return !!response?.ok;
  } catch {
    return false;
  }
}

// Restricted pages (chrome://, the Web Store, the PDF viewer, etc.) reject
// script injection. Surface that on the action badge so the click does not
// look like it was ignored.
function flashRestrictedPageBadge(tabId) {
  if (typeof tabId !== 'number') return;

  try {
    chrome.action.setBadgeText({ tabId, text: '!' });
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#dc2626' });
    chrome.action.setTitle({
      tabId,
      title: "QA Bridge can't run on this page (e.g. chrome:// pages, the Web Store, or PDFs)",
    });
    setTimeout(() => {
      chrome.action.setBadgeText({ tabId, text: '' });
      chrome.action.setTitle({ tabId, title: 'Pick Element' });
    }, 4000);
  } catch {
    // Ignore badge errors (for example, if the tab was closed in the meantime).
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;

  if (await closeExistingSession(tab.id)) return;

  try {
    await injectPicker(tab.id);
  } catch (error) {
    console.warn('Unable to start QA Bridge on this page:', error);
    flashRestrictedPageBadge(tab.id);
  }
});

function downloadDataUrl(dataUrl, filename) {
  return new Promise((resolve) => {
    chrome.downloads.download(
      {
        url: dataUrl,
        filename,
        saveAs: false,
        conflictAction: 'uniquify',
      },
      (downloadId) => {
        if (chrome.runtime.lastError || typeof downloadId !== 'number') {
          resolve({
            ok: false,
            error: chrome.runtime.lastError?.message || 'Unable to save screenshot',
          });
          return;
        }

        chrome.downloads.search({ id: downloadId }, (items) => {
          resolve({
            ok: true,
            downloadId,
            requestedFilename: filename,
            filename: items?.[0]?.filename || filename,
          });
        });
      }
    );
  });
}

async function postBundleToInbox(inboxUrl, payload) {
  const targetUrl = inboxUrl || 'http://127.0.0.1:43117/captures';

  try {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: body?.error || `Inbox server returned HTTP ${response.status}`,
      };
    }

    return {
      ok: true,
      ...body,
    };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || 'Unable to reach Codex QA inbox server',
    };
  }
}

async function postTraceToInbox(traceUrl, payload) {
  const targetUrl = traceUrl || CODEX_TRACE_URL;

  try {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: body?.error || `Inbox server returned HTTP ${response.status}`,
      };
    }

    return {
      ok: true,
      ...body,
    };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || 'Unable to reach Codex QA trace inbox server',
    };
  }
}

async function checkInboxHealth(healthUrl) {
  const targetUrl = healthUrl || 'http://127.0.0.1:43117/health';

  try {
    const response = await fetch(targetUrl, { method: 'GET' });
    if (!response.ok) {
      return { ok: false, status: response.status, error: `Inbox server returned HTTP ${response.status}` };
    }

    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    return { ok: true, root: body?.root || null };
  } catch (error) {
    return { ok: false, error: error?.message || 'Unable to reach Codex QA inbox server' };
  }
}

async function getLatestTour(tourUrl) {
  const targetUrl = tourUrl || 'http://127.0.0.1:43117/tours/latest';

  try {
    const response = await fetch(targetUrl);
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: body?.error || `Inbox server returned HTTP ${response.status}`,
      };
    }

    return {
      ok: true,
      ...body,
    };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || 'Unable to reach Codex QA inbox server',
    };
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') {
    return;
  }

  if (pendingToursByTab.has(tabId)) {
    const pendingTour = pendingToursByTab.get(tabId);
    pendingToursByTab.delete(tabId);

    injectPicker(tabId)
      .then(() => chrome.tabs.sendMessage(tabId, {
        type: 'ELEMENT_PICKER_RESUME_TOUR',
        tour: pendingTour.tour,
        stepIndex: pendingTour.stepIndex,
      }))
      .catch((error) => {
        console.warn('Unable to continue guided review after navigation:', error);
      });
    return;
  }

  if (!breakOnLoadTabs.has(tabId)) {
    return;
  }

  injectPicker(tabId)
    .then(() => chrome.tabs.sendMessage(tabId, {
      type: 'ELEMENT_PICKER_BREAK_ON_LOAD_RESUME',
      reason: 'page-load',
    }))
    .catch((error) => {
      console.warn('Unable to pause QA Bridge after page load:', error);
    });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  pendingToursByTab.delete(tabId);
  breakOnLoadTabs.delete(tabId);
});

// Capture the visible tab so the content script can build element crops.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) {
    return;
  }

  if (message.type === 'ELEMENT_PICKER_CAPTURE_VISIBLE') {
    const windowId = sender?.tab?.windowId;
    chrome.tabs.captureVisibleTab(windowId, { format: 'png' }, (dataUrl) => {
      if (chrome.runtime.lastError || !dataUrl) {
        sendResponse({
          ok: false,
          error: chrome.runtime.lastError?.message || 'Unable to capture viewport',
        });
        return;
      }

      sendResponse({ ok: true, dataUrl });
    });

    return true;
  }

  if (message.type === 'ELEMENT_PICKER_SAVE_IMAGE') {
    downloadDataUrl(message.dataUrl, message.filename).then(sendResponse);
    return true;
  }

  if (message.type === 'ELEMENT_PICKER_SEND_TO_CODEX') {
    postBundleToInbox(message.inboxUrl, {
      source: {
        extension: 'element-picker-qa-bridge',
        version: chrome.runtime.getManifest().version,
        tabId: sender?.tab?.id || null,
        tabUrl: sender?.tab?.url || null,
      },
      bundle: message.bundle,
      markdown: message.markdown || null,
    }).then(sendResponse);
    return true;
  }

  if (message.type === 'ELEMENT_PICKER_SEND_TRACE_TO_CODEX') {
    postTraceToInbox(message.traceUrl, {
      source: {
        extension: 'element-picker-qa-bridge',
        feature: 'vibe-debugger',
        version: chrome.runtime.getManifest().version,
        tabId: sender?.tab?.id || null,
        tabUrl: sender?.tab?.url || null,
      },
      trace: message.trace,
      markdown: message.markdown || null,
    }).then(sendResponse);
    return true;
  }

  if (message.type === 'ELEMENT_PICKER_CHECK_INBOX') {
    checkInboxHealth(message.healthUrl).then(sendResponse);
    return true;
  }

  if (message.type === 'ELEMENT_PICKER_GET_LATEST_TOUR') {
    getLatestTour(message.tourUrl).then(sendResponse);
    return true;
  }

  if (message.type === 'ELEMENT_PICKER_SET_BREAK_ON_LOAD') {
    const tabId = sender?.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: 'Missing active tab for Break on Load' });
      return;
    }

    if (message.enabled) {
      breakOnLoadTabs.set(tabId, {
        enabledAt: new Date().toISOString(),
        url: sender?.tab?.url || null,
      });
    } else {
      breakOnLoadTabs.delete(tabId);
    }

    sendResponse({ ok: true, enabled: breakOnLoadTabs.has(tabId) });
    return;
  }

  if (message.type === 'ELEMENT_PICKER_OPEN_TOUR_STEP') {
    const tabId = sender?.tab?.id;
    if (!tabId || !message.url) {
      sendResponse({ ok: false, error: 'Missing active tab or tour step URL' });
      return;
    }

    pendingToursByTab.set(tabId, {
      tour: message.tour || null,
      stepIndex: message.stepIndex || 0,
    });

    chrome.tabs.update(tabId, { url: message.url }, () => {
      if (chrome.runtime.lastError) {
        pendingToursByTab.delete(tabId);
        sendResponse({
          ok: false,
          error: chrome.runtime.lastError.message || 'Unable to open tour step',
        });
        return;
      }

      sendResponse({ ok: true });
    });
    return true;
  }
});
