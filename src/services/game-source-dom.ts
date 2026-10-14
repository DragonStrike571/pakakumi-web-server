export interface GameSourceSnapshot {
  busts: string[];
  counts: string[];
  amounts: string[];
  profits: string[];
  layout: "history-table" | "history-strip";
}

// Runs in the page, independently of Node/TS module bindings. Generated CSS classes
// are hints for the old layout only; new history is identified by its structure.
export const GAME_SOURCE_READER = String.raw`(() => {
  const validBust = text => {
    const value = (text || '').trim();
    if (!/^\d+(?:,\d{3})*(?:\.\d+)?\s*[x×]?$/i.test(value)) return false;
    const number = Number(value.replace(/[x×\s,]/gi, ''));
    return Number.isFinite(number) && number >= 1;
  };
  const visible = element => element.getClientRects().length > 0 && !element.closest('[hidden],[aria-hidden="true"]');
  let history = null;
  let busts = [];
  let layout = 'history-table';
  const legacy = document.querySelector('table.css-1a87jyo tbody');
  const oldValues = legacy ? Array.from(legacy.querySelectorAll('tr.css-15iar3s td span.css-hwpcld')).map(node => node.textContent.trim()) : [];
  if (legacy && visible(legacy) && oldValues.length >= 10 && oldValues.every(validBust)) {
    history = legacy;
    busts = oldValues;
  } else {
    const candidates = [];
    // Table fallback accepts only single-cell multiplier rows, never player tables.
    for (const body of document.querySelectorAll('table tbody')) {
      if (!visible(body)) continue;
      const rows = Array.from(body.children);
      if (rows.length < 10 || rows.length > 100 || rows.some(row => row.tagName !== 'TR' || row.children.length !== 1)) continue;
      const values = rows.map(row => row.textContent.trim());
      if (values.every(validBust)) candidates.push({ node: body, values, layout: 'history-table' });
    }
    // The current crash page has forty direct span children, newest first.
    // Require a complete numeric strip and reject conflicting matches.
    const parents = new Set(Array.from(document.querySelectorAll('span')).map(node => node.parentElement));
    for (const parent of parents) {
      if (!parent || !visible(parent) || parent.closest('table,form,[role="table"]')) continue;
      const children = Array.from(parent.children);
      if (children.length < 10 || children.length > 100 || children.some(node => node.tagName !== 'SPAN' || node.children.length > 0)) continue;
      const values = children.map(node => node.textContent.trim());
      if (values.every(validBust)) candidates.push({ node: parent, values, layout: 'history-strip' });
    }
    if (!candidates.length) return null;
    const first = candidates[0];
    if (candidates.some(candidate => JSON.stringify(candidate.values) !== JSON.stringify(first.values))) return null;
    history = first.node;
    busts = first.values;
    layout = first.layout;
  }
  if (typeof window.__onDomChanged === 'function') {
    // Observe the parent so replacing the history element still signals a scrape.
    // Each read also reattaches if the provider replaced the parent itself.
    const root = history.parentElement || history;
    if (window.__pakakumiObservedRoot !== root) {
      window.__pakakumiObserver?.disconnect();
      const observer = new MutationObserver(() => {
        Promise.resolve(window.__onDomChanged()).catch(() => {});
      });
      observer.observe(root, { childList: true, subtree: true, characterData: true });
      window.__pakakumiObserver = observer;
      window.__pakakumiObservedRoot = root;
    }
  }
  const texts = selector => Array.from(document.querySelectorAll(selector)).map(node => node.textContent || '');
  // New player rows use different columns and may be virtualized. Their WIN
  // column cannot be assumed to be the old net-profit column: preserve nulls.
  const legacyMetrics = history === legacy && oldValues.length >= 10;
  const counter = label => {
    const matches = Array.from(document.querySelectorAll('strong')).filter(node => {
      const parent = node.parentElement;
      return parent && visible(parent) && Array.from(parent.children).some(child => child.tagName === 'SPAN' && child.textContent.trim().toLowerCase() === label);
    });
    return matches.length === 1 ? matches[0].textContent.trim() : '';
  };
  return {
    busts: busts.slice(0, 40), layout,
    counts: legacyMetrics ? texts('div.css-eb3kfa strong') : [counter('online'), counter('playing')],
    amounts: legacyMetrics ? texts('div.css-afms4i table.css-1a87jyo tbody tr td:nth-child(3)') : [],
    profits: legacyMetrics ? texts('div.css-afms4i table.css-1a87jyo tbody tr td:nth-child(4)') : []
  };
})()`;
