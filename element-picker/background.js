const TAB_STATE_PREFIX = 'qaBridgeTab:';
const tabStateWrites = new Map();
const tabResumes = new Map();

// EP-7 and EP-6 share a tab lifetime, but keep independent Break on Load and
// tour state. Only these serialized mutations write the browser-session store.
function changeTabState(tabId, change) {
  const key = `${TAB_STATE_PREFIX}${tabId}`;
  const write = (tabStateWrites.get(tabId) || Promise.resolve()).then(async () => {
    const saved = await chrome.storage.session.get(key);
    const current = saved[key] || { breakOnLoadEnabled: false, tour: null, delivery: null };
    const next = change(current);
    if (next !== current) {
      if (next.breakOnLoadEnabled || next.tour) {
        await chrome.storage.session.set({ [key]: next });
      } else {
        await chrome.storage.session.remove(key);
      }
    }
    return next;
  });
  const settled = write.catch(() => {});
  tabStateWrites.set(tabId, settled);
  settled.then(() => { if (tabStateWrites.get(tabId) === settled) tabStateWrites.delete(tabId); });
  return write;
}

function readTabState(tabId) {
  return changeTabState(tabId, state => state);
}

function pendingDelivery(expectedUrl = null) {
  return { token: crypto.randomUUID(), status: 'pending', expectedUrl };
}

function ownsDocument(state, sender) {
  return !state.documentId || !sender.documentId || state.documentId === sender.documentId;
}

async function clearNavigationBadge(tabId) {
  await chrome.action.setBadgeText({ tabId, text: '' });
  await chrome.action.setTitle({ tabId, title: 'Pick Element' });
}

async function failDelivery(tabId, token, error) {
  let retained = false;
  await changeTabState(tabId, state => {
    if (state.delivery?.token !== token) return state;
    retained = true;
    return { ...state, delivery: { ...state.delivery, status: 'failed', error: error.message } };
  });
  if (!retained) return;
  await chrome.action.setBadgeText({ tabId, text: '!' });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: '#dc2626' });
  await chrome.action.setTitle({ tabId, title: 'QA Bridge could not resume. Click to retry on this page.' });
}

function resumeTab(tabId, { manual = false } = {}) {
  const resume = (tabResumes.get(tabId) || Promise.resolve()).then(async () => {
    let state = await readTabState(tabId);
    if (!state.breakOnLoadEnabled && !state.tour) return false;
    const tab = await chrome.tabs.get(tabId);
    if (tab.status !== 'complete') return false;
    if (manual || !state.delivery) {
      state = await changeTabState(tabId, current => current.breakOnLoadEnabled || current.tour
        ? { ...current, delivery: pendingDelivery() } : current);
    }
    if (!state.delivery || (!state.breakOnLoadEnabled && !state.tour)) return false;
    const token = state.delivery.token;
    try {
      if (!manual && state.delivery.expectedUrl && tab.url !== state.delivery.expectedUrl) {
        throw new Error('The tour destination changed');
      }
      const documentId = await injectPicker(tabId);
      state = await changeTabState(tabId, current => current.delivery?.token === token
        ? { ...current, documentId } : current);
      if (state.delivery?.token !== token) return false;
      const message = state.tour ? {
        type: 'ELEMENT_PICKER_RESUME_TOUR', ...state.tour,
        breakOnLoadEnabled: state.breakOnLoadEnabled, resumeToken: token,
      } : {
        type: 'ELEMENT_PICKER_BREAK_ON_LOAD_RESUME', breakOnLoadEnabled: true,
        reason: 'page-load', resumeToken: token,
      };
      const acknowledgement = await chrome.tabs.sendMessage(tabId, message,
        documentId ? { documentId } : { frameId: 0 });
      if (!acknowledgement?.ok || acknowledgement.resumeToken !== token) {
        throw new Error('The page did not acknowledge QA Bridge restoration');
      }
      const delivered = await changeTabState(tabId, current => current.delivery?.token === token
        ? { ...current, delivery: { token, status: 'active' } } : current);
      if (delivered.delivery?.token !== token || delivered.delivery.status !== 'active') return false;
      await clearNavigationBadge(tabId);
      return true;
    } catch (error) {
      await failDelivery(tabId, token, error);
      return false;
    }
  }).catch(error => { console.warn('Unable to restore QA Bridge tab state:', error); return false; });
  tabResumes.set(tabId, resume);
  resume.then(() => { if (tabResumes.get(tabId) === resume) tabResumes.delete(tabId); });
  return resume;
}

async function injectPicker(tabId) {
  // A CSS failure must not leave an apparently live but unfinished session.
  await chrome.scripting.insertCSS({ target: { tabId }, files: ['picker.css'] });
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['vibe-page-probe.js'],
      world: 'MAIN'
    });
  } catch (error) {
    console.warn('Unable to inject Vibe Debugger page probe:', error);
  }

  const injected = await chrome.scripting.executeScript({
    target: { tabId },
    files: ['picker.js']
  });

  return injected?.find(result => result.frameId === 0)?.documentId || null;
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

async function handleActionClick(tab) {
  if (!tab?.id) return;
  try {
    const state = await readTabState(tab.id);
    if (state.delivery && state.delivery.status !== 'active') {
      await resumeTab(tab.id, { manual: true });
      return;
    }
    if (await closeExistingSession(tab.id)) return;
    if (state.breakOnLoadEnabled || state.tour) await resumeTab(tab.id, { manual: true });
    else await injectPicker(tab.id);
  } catch (error) {
    console.warn('Unable to start QA Bridge on this page:', error);
    flashRestrictedPageBadge(tab.id);
  }
}
chrome.action.onClicked.addListener(handleActionClick);

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

async function postToInbox(targetUrl, payload) {
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
  if (changeInfo.status === 'loading') {
    changeTabState(tabId, state => state.breakOnLoadEnabled || state.tour
      ? { ...state, delivery: pendingDelivery(state.delivery?.status === 'pending' ? state.delivery.expectedUrl : null) }
      : state).catch(error => console.warn('Unable to retain QA Bridge navigation:', error));
  } else if (changeInfo.status === 'complete') {
    resumeTab(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  changeTabState(tabId, () => ({ breakOnLoadEnabled: false, tour: null }))
    .catch(error => console.warn('Unable to remove closed QA Bridge tab:', error));
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
    postToInbox(message.inboxUrl || 'http://127.0.0.1:43117/captures', {
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
    postToInbox(message.traceUrl || 'http://127.0.0.1:43117/traces', {
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

    changeTabState(tabId, state => ({
      ...state, breakOnLoadEnabled: !!message.enabled,
      delivery: state.delivery || { token: crypto.randomUUID(), status: 'active' },
    })).then(async state => {
      if (!state.breakOnLoadEnabled && !state.tour) await clearNavigationBadge(tabId);
      sendResponse({ ok: true, enabled: state.breakOnLoadEnabled });
    })
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'ELEMENT_PICKER_SAVE_TOUR') {
    const tabId = sender?.tab?.id;
    if (!tabId || !message.tour?.steps?.length || !message.sessionId) {
      sendResponse({ ok: false, error: 'Missing tour checkpoint' });
      return;
    }
    changeTabState(tabId, state => {
      if (!message.newTour && (state.tour?.sessionId !== message.sessionId ||
          !ownsDocument(state, sender) || state.delivery?.status !== 'active')) return state;
      return { ...state, documentId: sender.documentId,
        tour: { tour: message.tour, sessionId: message.sessionId,
          stepIndex: message.stepIndex || 0, askNotes: message.askNotes || [] },
        delivery: { token: crypto.randomUUID(), status: 'active' },
      };
    }).then(() => sendResponse({ ok: true }))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'ELEMENT_PICKER_CLEAR_TOUR' || message.type === 'ELEMENT_PICKER_CLEAR_SESSION') {
    const tabId = sender?.tab?.id;
    if (!tabId) { sendResponse({ ok: false, error: 'Missing QA Bridge tab' }); return; }
    let cleared = false;
    changeTabState(tabId, state => {
      if (!ownsDocument(state, sender)) return state;
      if (message.type === 'ELEMENT_PICKER_CLEAR_TOUR' && state.tour?.sessionId !== message.sessionId) return state;
      cleared = true;
      return { breakOnLoadEnabled: message.type === 'ELEMENT_PICKER_CLEAR_SESSION' ? false : state.breakOnLoadEnabled,
        tour: null, delivery: { token: crypto.randomUUID(), status: 'active' }, documentId: sender.documentId };
    }).then(async () => {
      if (cleared && message.sessionId) {
        await chrome.tabs.sendMessage(tabId, { type: 'ELEMENT_PICKER_TOUR_ENDED', sessionId: message.sessionId }).catch(() => {});
      }
      if (cleared) await clearNavigationBadge(tabId);
      sendResponse({ ok: true, cleared });
    }).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'ELEMENT_PICKER_OPEN_TOUR_STEP') {
    const tabId = sender?.tab?.id;
    if (!tabId || !message.url) {
      sendResponse({ ok: false, error: 'Missing active tab or tour step URL' });
      return;
    }

    let token;
    changeTabState(tabId, state => {
      if (!message.tour?.steps?.length || !ownsDocument(state, sender) ||
          (state.tour && state.tour.sessionId !== message.sessionId)) throw new Error('This tour is no longer active');
      const delivery = pendingDelivery(message.url);
      token = delivery.token;
      return { ...state, delivery, documentId: sender.documentId,
        tour: { tour: message.tour, stepIndex: message.stepIndex || 0,
          sessionId: message.sessionId || crypto.randomUUID(), askNotes: message.askNotes || [] },
      };
    }).then(async () => {
      if ((await readTabState(tabId)).delivery?.token !== token) throw new Error('Tour navigation was cancelled');
      await chrome.tabs.update(tabId, { url: message.url });
      sendResponse({ ok: true });
    }).catch(async error => {
      if (token) await failDelivery(tabId, token, error).catch(saveError => console.warn('Unable to retain tour failure:', saveError));
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }
});
