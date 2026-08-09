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
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['core.js', 'content.js'],
  });
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
