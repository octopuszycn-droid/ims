const apiBase = document.querySelector('#apiBase');
const status = document.querySelector('#status');
chrome.storage.local.get(['apiBase']).then((config) => {
  if (config.apiBase) apiBase.value = config.apiBase;
  updateAuthStatus();
});
function saveApiBase() {
  const value = apiBase.value.trim();
  let base;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    base = url.origin;
  } catch {
    throw new Error('请输入有效的 IMS 地址，例如 http://127.0.0.1:5173/');
  }
  apiBase.value = base;
  return chrome.storage.local.set({ apiBase: base }).then(() => base);
}
let saveTimer;
apiBase.addEventListener('input', () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveApiBase().catch(() => {}), 250);
});
apiBase.addEventListener('change', () => saveApiBase().catch((error) => { status.textContent = error.message; }));
apiBase.addEventListener('blur', () => saveApiBase().catch((error) => { status.textContent = error.message; }));
function updateAuthStatus() {
  chrome.runtime.sendMessage({ type: 'IMS_AUTH_STATUS' }, (result) => {
    const connected = Boolean(result?.connected);
    document.querySelector('#auth').textContent = connected ? 'IMS 已连接' : '尚未检测到 IMS 登录，请先登录';
    const loginButton = document.querySelector('#login');
    loginButton.textContent = connected ? '已登录，重新登录' : '打开 IMS 登录';
    loginButton.classList.toggle('login-connected', connected);
    document.querySelector('#syncControls').hidden = !connected;
  });
}
document.querySelector('#login').addEventListener('click', async () => {
  try {
    const base = await saveApiBase();
    chrome.tabs.create({ url: `${base}/` });
  } catch (error) {
    status.textContent = error.message;
  }
});
document.querySelector('#sync').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  status.textContent = '';
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let result;
  try { result = await chrome.tabs.sendMessage(tab.id, { type: 'IMS_SELECTED_ORDERS' }); }
  catch { status.textContent = '请在拼多多打单列表页面使用。'; return; }
  const orders = result?.orders || [];
  if (!orders.length) { status.textContent = '没有读取到已勾选的有效订单。'; return; }
  const platform = document.querySelector('#platform').value;
  if (!confirm(`将同步 ${orders.length} 条商品出库记录，确认继续？`)) return;
  try { await saveApiBase(); }
  catch (error) { status.textContent = error.message; return; }
  button.disabled = true;
  status.textContent = '正在同步…';
  chrome.runtime.sendMessage({ type: 'IMS_SYNC', payload: { platform, orders } }, (response) => {
    button.disabled = false;
    if (response?.ok) {
      status.textContent = `同步成功：${orders.length} 条记录。`;
      return;
    }
    if (response?.failures?.length) {
      const alertText = response.failures
        .map(({ orderId, reason }) => `订单编号：${orderId}，${reason}`)
        .join('\n');
      status.textContent = '存在未匹配或库存不足订单，本次未扣减库存。';
      chrome.tabs.sendMessage(tab.id, { type: 'IMS_SYNC_FAILURE', text: alertText }, () => {
        if (chrome.runtime.lastError) window.alert(alertText);
      });
      return;
    }
    status.textContent = response?.error || '同步失败';
    if (!response?.ok && /登录已过期|请先.*登录/.test(response?.error || '')) updateAuthStatus();
  });
});
