// PDFGeek background: opens the PDFGeek tab from the toolbar button and adds "Open in PDFGeek" to PDF links.
// It never reads pages and never sends anything anywhere.
const APP = chrome.runtime.getURL('app.html');

async function openApp(query = '') {
  if (!query) {
    // Reuse a PDFGeek tab that is already open. getContexts lists our own pages without needing the tabs permission.
    let tabId = -1;
    try {
      const ctx = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
      const c = ctx.find((x) => x.documentUrl && x.documentUrl.startsWith(APP) && x.tabId >= 0);
      if (c) tabId = c.tabId;
    } catch { /* older browser */ }
    if (tabId >= 0) {
      const t = await chrome.tabs.update(tabId, { active: true }).catch(() => null);
      if (t) { await chrome.windows.update(t.windowId, { focused: true }).catch(() => {}); return tabId; }
    }
  }
  const t = await chrome.tabs.create({ url: APP + query });
  return t.id;
}

chrome.action.onClicked.addListener(() => { openApp(); });

const PDF_LINKS = ['*://*/*.pdf', '*://*/*.pdf?*', '*://*/*.pdf#*', '*://*/*.PDF', '*://*/*.PDF?*'];
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'open-pdf', title: 'Open in PDFGeek', contexts: ['link'], targetUrlPatterns: PDF_LINKS });
  });
});

function onMenu(info) {
  if (info.menuItemId !== 'open-pdf' || !info.linkUrl) return;
  let u;
  try { u = new URL(info.linkUrl); } catch { return; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
  // The PDFGeek tab asks for access to this one site (with an Allow button) before it downloads the file.
  openApp('?src=' + encodeURIComponent(u.href));
}
chrome.contextMenus.onClicked.addListener(onMenu);
