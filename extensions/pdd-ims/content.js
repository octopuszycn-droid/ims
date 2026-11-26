const IMS_ORIGINS = new Set(['https://whblf.work', 'http://127.0.0.1:5173']);
let lastSessionToken = null;

function syncImsSession() {
  if (!IMS_ORIGINS.has(location.origin)) return;
  const session = (() => {
    try { return JSON.parse(localStorage.getItem('fish-cms-session') || 'null'); }
    catch { return null; }
  })();
  const token = session?.token || '';
  if (token === lastSessionToken) return;
  lastSessionToken = token;
  chrome.runtime.sendMessage({ type: 'IMS_UPDATE_SESSION', token });
}

if (IMS_ORIGINS.has(location.origin)) {
  syncImsSession();
  window.setInterval(syncImsSession, 3000);
}

function selectedRows() {
  return [...document.querySelectorAll('tr[data-testid="beast-core-table-body-tr"]')].filter((row) => {
    const check = row.querySelector('label[data-testid="beast-core-checkbox"]');
    return check?.getAttribute('data-checked') === 'true' || Boolean(row.querySelector('input[type="checkbox"]:checked'));
  });
}

function extractOrders() {
  const output = [];
  for (const row of selectedRows()) {
    const cells = [...row.querySelectorAll(':scope > td')];
    const shopText = cells[5]?.innerText || '';
    const orderId = cells[8]?.querySelector('.order-sn')?.innerText?.trim() || '';
    const shopName = shopText.split('\n').map((value) => value.trim()).find(Boolean) || '';
    const shopIncome = (shopText.match(/实收\s*[:：]\s*[¥￥]?\s*([\d,.]+)/) || [])[1]?.replace(/,/g, '') || '';
    const itemBlocks = [...(cells[6]?.querySelectorAll('.sc-gipzik') || [])];
    const parsed = itemBlocks.map((block) => {
      const textParts = [...block.querySelectorAll('.content-wrapper > span')]
        .map((span) => span.innerText.trim())
        .filter((value) => value && !/^x\s*\d+$/i.test(value));
      const qtyText = [...block.querySelectorAll('.content-wrapper > span')]
        .map((span) => span.innerText.trim())
        .find((value) => /^x\s*\d+$/i.test(value));
      const productText = textParts.join(' ').replace(/\s+/g, ' ').trim();
      const quantity = Number((qtyText?.match(/\d+/) || [])[0] || 0);
      return { productText, quantity };
    }).filter((item) => item.productText && item.quantity > 0);
    if (!orderId || !parsed.length) continue;
    parsed.forEach((item, index) => output.push({
      orderId, shopName, shopIncome: index === 0 ? shopIncome : '',
      productText: item.productText, quantity: item.quantity,
    }));
  }
  return output;
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type === 'IMS_SELECTED_ORDERS') {
    respond({ orders: extractOrders() });
    return;
  }
  if (message?.type === 'IMS_SYNC_FAILURE') {
    window.alert(message.text || '订单同步失败，本次未扣减库存。');
    respond({ ok: true });
  }
});
