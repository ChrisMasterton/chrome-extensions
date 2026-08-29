// Toolbar click toggles the Vibe Digger panel in the active tab.

// Ask an already-running panel in this tab to toggle itself. Returns true when
// a live content script handled the click, so the icon works as an on/off
// switch instead of stacking injections.
async function tryToggle(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: 'VIBE_DIGGER_TOGGLE',
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
      title: "Vibe Digger can't run on this page (e.g. chrome:// pages, the Web Store, or PDFs)",
    });
    setTimeout(() => {
      chrome.action.setBadgeText({ tabId, text: '' });
      chrome.action.setTitle({ tabId, title: 'Toggle Vibe Digger' });
    }, 4000);
  } catch {
    // Ignore badge errors (for example, if the tab was closed in the meantime).
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  if (typeof tab?.id !== 'number') return;

  if (await tryToggle(tab.id)) return;

  try {
    // The page agent is pre-installed on localhost via manifest content
    // scripts; injecting again is a guarded no-op. On other sites this is the
    // first (late) install, which limits the heatmap but keeps the inspector
    // and issue capture working from this point on.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['page-agent.js'],
      world: 'MAIN',
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js'],
    });
  } catch (error) {
    console.warn('Vibe Digger could not attach to this tab:', error);
    flashRestrictedPageBadge(tab.id);
  }
});
