const RESTRICTED_BADGE_DURATION_MS = 4000;

async function toggleExistingOverlay(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: 'TEST_USERS_TOGGLE',
    });
    return Boolean(response?.ok);
  } catch {
    return false;
  }
}

async function injectOverlay(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['core.js', 'content.js'],
    });
  } catch {
    // A page that rejects all-frame injection outright still deserves the overlay.
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['core.js', 'content.js'],
    });
  }
}

async function fillEveryFrame(tabId, user) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    // Programmatic funcs share the isolated world with the injected content
    // script, so the hook each frame registered is visible here.
    func: (fillUser) =>
      globalThis.__testUsersFillHook ? globalThis.__testUsersFillHook(fillUser) : null,
    args: [user],
  });

  return results.flatMap((result) => (Array.isArray(result?.result) ? result.result : []));
}

function showRestrictedPageBadge(tabId) {
  if (typeof tabId !== 'number') return;

  chrome.action.setBadgeText({ tabId, text: '!' });
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#dc2626' });
  chrome.action.setTitle({
    tabId,
    title: "Test Users can't run on browser pages, the Web Store, or PDFs",
  });

  setTimeout(() => {
    chrome.action.setBadgeText({ tabId, text: '' });
    chrome.action.setTitle({ tabId, title: 'Toggle Test Users' });
  }, RESTRICTED_BADGE_DURATION_MS);
}

async function snapshotEveryFrame(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () =>
      globalThis.__testUsersSnapshotHook ? globalThis.__testUsersSnapshotHook() : null,
  });

  return results.flatMap((result) => (Array.isArray(result?.result) ? result.result : []));
}

async function refillEveryFrame(tabId, fields) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: (snapshotFields) =>
      globalThis.__testUsersRefillHook ? globalThis.__testUsersRefillHook(snapshotFields) : null,
    args: [fields],
  });

  return results.flatMap((result) => (Array.isArray(result?.result) ? result.result : []));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handlers = {
    TEST_USERS_FILL_ALL_FRAMES: (tabId) =>
      fillEveryFrame(tabId, message.user).then((purposes) => ({ purposes })),
    TEST_USERS_SNAPSHOT_ALL_FRAMES: (tabId) =>
      snapshotEveryFrame(tabId).then((fields) => ({ fields })),
    TEST_USERS_REFILL_ALL_FRAMES: (tabId) =>
      refillEveryFrame(tabId, message.fields).then((fieldIds) => ({ fieldIds })),
  };
  const handler = handlers[message?.type];
  if (!handler) return false;

  try {
    const tabId = sender.tab?.id;
    if (typeof tabId !== 'number') throw new Error('Frame request without a tab');

    handler(tabId)
      .then(sendResponse)
      .catch(() => sendResponse(null));
  } catch {
    sendResponse(null);
    return false;
  }

  return true;
});

chrome.action.onClicked.addListener(async (tab) => {
  if (typeof tab?.id !== 'number') return;

  if (await toggleExistingOverlay(tab.id)) return;

  try {
    await injectOverlay(tab.id);
  } catch (error) {
    console.warn('Unable to start Test Users on this page:', error);
    showRestrictedPageBadge(tab.id);
  }
});
