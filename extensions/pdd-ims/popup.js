const apiBase = document.querySelector('#apiBase');
const status = document.querySelector('#status');
chrome.storage.local.get(['apiBase']).then((config) => {
  if (config.apiBase) apiBase.value = config.apiBase;
  updateAuthStatus();
});
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
document.querySelector('#login').addEventListener('click', () => {
  chrome.tabs.create({ url: `${apiBase.value.trim().replace(/\/$/, '')}/` });
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
  await chrome.storage.local.set({ apiBase: apiBase.value.trim() });
  button.disabled = true;
  status.textContent = '正在同步…';
  chrome.runtime.sendMessage({ type: 'IMS_SYNC', payload: { platform, orders } }, (response) => {
    button.disabled = false;
    status.textContent = response?.ok ? `同步成功：${orders.length} 条记录。` : (response?.error || '同步失败');
    if (!response?.ok && /登录已过期|请先.*登录/.test(response?.error || '')) updateAuthStatus();
  });
});
