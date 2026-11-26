chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type === 'IMS_UPDATE_SESSION') {
    const token = String(message.token || '');
    (token ? chrome.storage.local.set({ token }) : chrome.storage.local.remove('token'))
      .then(() => respond({ ok: true }));
    return true;
  }
  if (message?.type === 'IMS_AUTH_STATUS') {
    chrome.storage.local.get(['token']).then(({ token }) => respond({ connected: Boolean(token) }));
    return true;
  }
  if (message?.type !== 'IMS_SYNC') return;
  (async () => {
    const config = await chrome.storage.local.get(['apiBase', 'token']);
    if (!config.token) throw new Error('请先配置 IMS 登录令牌');
    const base = (config.apiBase || 'https://whblf.work').replace(/\/$/, '');
    const response = await fetch(`${base}/api/inventory/orders/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` },
      body: JSON.stringify(message.payload),
    });
    const body = await response.json().catch(() => ({}));
    if (response.status === 401) {
      await chrome.storage.local.remove('token');
      throw new Error('IMS 登录已过期，请先登录 IMS 后再同步。');
    }
    if (!response.ok) {
      const error = new Error(body.error || body.message || `请求失败：${response.status}`);
      error.failures = Array.isArray(body.errors) ? body.errors : [];
      throw error;
    }
    return body;
  })().then((data) => respond({ ok: true, data })).catch((error) => respond({ ok: false, error: error.message, failures: error.failures || [] }));
  return true;
});
