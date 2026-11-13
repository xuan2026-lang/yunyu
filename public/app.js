const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const CLOUD_FAVORITES_KEY = 'yunyu.cloud.favorites';
const CLOUD_RECENT_KEY = 'yunyu.cloud.recent';
const MOMENTS_SEEN_KEY = 'yunyu.moments.seen';
const MOMENT_ACTIVITY_SEEN_KEY = 'yunyu.moments.activitySeen';
const MOMENT_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const state = {
  user: null,
  authMode: 'login',
  view: 'chat',
  friends: [],
  requests: { incoming: [], outgoing: [] },
  conversations: [],
  games: [],
  activeConversationId: null,
  messages: [],
  hasMore: false,
  fileData: { files: [], used: 0, limit: 1, maxFileSize: 25 * 1024 * 1024 },
  fileFilter: 'all',
  onlineUserIds: new Set(),
  searchUsers: [],
  socket: null,
  searchSequence: 0,
  typingUser: null,
  typingTimer: null,
  cloudCategory: 'all',
  cloudQuery: '',
  cloudFavorites: new Set(readStoredList(CLOUD_FAVORITES_KEY)),
  cloudRecent: readStoredList(CLOUD_RECENT_KEY),
  moments: [],
  momentsHasMore: false,
  momentsLoading: false,
  momentsLatestId: 0,
  momentFilter: 'all',
  momentDraft: [],
  momentCommentOpen: new Set(),
  momentReplies: {},
  momentNotifications: [],
  momentUnread: 0
};

const PROFILE_COLORS = ['#4f7568', '#657b9b', '#a46f52', '#8a6f8e', '#56727f'];

function readStoredList(key) {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}
function writeStoredList(key, list) {
  try { localStorage.setItem(key, JSON.stringify(list)); } catch { /* 隐私模式下忽略存储失败 */ }
}

const GAME_ENV_KEYS = {
  genshin: 'CLOUD_GENSHIN_URL',
  'wuthering-waves': 'CLOUD_WUTHERING_WAVES_URL',
  'honkai-star-rail': 'CLOUD_STAR_RAIL_URL',
  'zenless-zone-zero': 'CLOUD_ZZZ_URL'
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[char]);
}
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const initial = (name) => Array.from(String(name || '云').trim())[0] || '云';
const isOnline = (id) => state.onlineUserIds.has(id);
const currentConversation = () => state.conversations.find((item) => item.id === state.activeConversationId);

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** index);
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}
function formatTime(iso) {
  const date = new Date(iso);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}
function formatFullDate(iso) {
  return new Date(iso).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}
function dayLabel(iso) {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (date.toDateString() === today.toDateString()) return '今天';
  if (date.toDateString() === yesterday.toDateString()) return '昨天';
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
}
function avatarHtml(user, extra = '') {
  const name = user?.display_name || user?.name || '云';
  const online = user?.id && isOnline(user.id);
  return `<span class="avatar-wrap"><span class="avatar ${extra}" style="background:${escapeHtml(user?.avatar_color || '#4f7568')}">${escapeHtml(initial(name))}</span>${online ? '<span class="online-dot"></span>' : ''}</span>`;
}
function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast ${type === 'error' ? 'error' : ''}`;
  toast.textContent = message;
  $('#toast-region').append(toast);
  setTimeout(() => toast.remove(), 3600);
}
function setBusy(button, busy, busyText = '处理中…') {
  if (busy) {
    button.dataset.originalHtml = button.innerHTML;
    button.disabled = true;
    button.textContent = busyText;
  } else {
    button.disabled = false;
    if (button.dataset.originalHtml) button.innerHTML = button.dataset.originalHtml;
  }
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('X-Requested-With', 'XMLHttpRequest');
  let body = options.body;
  if (body && !(body instanceof FormData) && typeof body !== 'string') {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(body);
  }
  const response = await fetch(`/api${path}`, { ...options, headers, body, credentials: 'same-origin' });
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : {};
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/auth/')) showAuth();
    throw new Error(data.error || `请求失败（${response.status}）`);
  }
  return data;
}

function openModal(title, content) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = content;
  if (!$('#modal').open) $('#modal').showModal();
}
function closeModal() { $('#modal').close(); }
function openConfirm(title, message, onConfirm) {
  openModal(title, `<p class="muted">${escapeHtml(message)}</p><div class="modal-actions"><button id="confirm-cancel" class="button button-secondary" type="button">取消</button><button id="confirm-ok" class="button button-danger" type="button">确认</button></div>`);
  $('#confirm-cancel').addEventListener('click', closeModal);
  $('#confirm-ok').addEventListener('click', async (event) => {
    setBusy(event.currentTarget, true);
    try { await onConfirm(); closeModal(); } catch (error) { showToast(error.message, 'error'); setBusy(event.currentTarget, false); }
  });
}

function setAuthMode(mode) {
  state.authMode = mode;
  const register = mode === 'register';
  $$('.segment').forEach((button) => {
    const active = button.dataset.authMode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  $('#auth-title').textContent = register ? '创建你的账号' : '登录你的账号';
  $('#auth-subtitle').textContent = register ? '无需邮箱，设置用户名和密码即可。' : '只需要用户名和密码，无需邮箱。';
  $('#auth-submit').textContent = register ? '注册并进入云屿' : '登录并进入云屿';
  $('#auth-password').autocomplete = register ? 'new-password' : 'current-password';
  $('#password-hint').hidden = !register;
  $('#auth-error').hidden = true;
}
function showAuth() {
  state.socket?.disconnect();
  state.socket = null;
  state.user = null;
  state.activeConversationId = null;
  $('#main-view').hidden = true;
  $('#auth-view').hidden = false;
  setAuthMode('login');
}
async function submitAuth(event) {
  event.preventDefault();
  const button = $('#auth-submit');
  const errorNode = $('#auth-error');
  errorNode.hidden = true;
  const username = $('#auth-username').value.trim();
  const password = $('#auth-password').value;
  if (!username || !password) {
    errorNode.textContent = '请输入用户名和密码';
    errorNode.hidden = false;
    return;
  }
  setBusy(button, true, state.authMode === 'login' ? '正在登录…' : '正在注册…');
  try {
    await api(`/auth/${state.authMode}`, { method: 'POST', body: { username, password } });
    $('#auth-password').value = '';
    await loadBootstrap();
    showToast(state.authMode === 'login' ? '欢迎回来' : '账号创建成功，欢迎来到云屿');
  } catch (error) {
    errorNode.textContent = error.message;
    errorNode.hidden = false;
  } finally {
    setBusy(button, false);
  }
}

async function loadBootstrap() {
  const data = await api('/bootstrap');
  state.user = data.user;
  state.friends = data.friends;
  state.requests = data.requests;
  state.conversations = data.conversations;
  state.games = data.games;
  $('#auth-view').hidden = true;
  $('#main-view').hidden = false;
  $('#user-menu-button').textContent = initial(state.user.display_name);
  $('#user-menu-button').style.background = state.user.avatar_color;
  switchView(state.view, false);
  renderAll();
  connectSocket();
  // 预取一次动态，用于导航上的「有新动态」红点。
  loadMoments();
  loadMomentNotifications();
  if (window.matchMedia('(min-width: 800px)').matches && !state.activeConversationId && state.conversations[0]) {
    await openConversation(state.conversations[0].id);
  }
}
function renderAll() {
  renderNavBadges();
  renderConversations();
  renderContacts();
  renderGames();
}
function switchView(view, resetChat = true) {
  state.view = view;
  $$('.app-view').forEach((section) => { section.hidden = section.id !== `view-${view}`; });
  $$('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  if (view === 'files') loadFiles().catch((error) => showToast(error.message, 'error'));
  if (view === 'contacts') renderContacts();
  if (view === 'cloud') renderGames();
  if (view === 'moments') {
    loadMoments();
    loadMomentNotifications();
    $('#nav-moments').hidden = true;
  }
  if (view === 'chat' && resetChat && window.innerWidth < 800) $('#view-chat').classList.remove('chat-detail');
}
function renderNavBadges() {
  const unread = state.conversations.reduce((sum, item) => sum + (item.unread || 0), 0);
  $('#nav-unread').hidden = unread === 0;
  $('#nav-unread').textContent = unread > 99 ? '99+' : String(unread);
  $('#nav-requests').hidden = state.requests.incoming.length === 0;
}

function renderConversations() {
  const query = $('#conversation-search').value.trim().toLowerCase();
  const list = state.conversations.filter((item) => item.name.toLowerCase().includes(query));
  if (!list.length) {
    $('#conversation-list').innerHTML = `<div class="empty-inline"><strong>${query ? '没有匹配的会话' : '还没有会话'}</strong><span>${query ? '换个关键词试试' : '去联系人页面找朋友聊聊吧'}</span></div>`;
    return;
  }
  $('#conversation-list').innerHTML = list.map((conversation) => {
    const last = conversation.last_message;
    let preview = '暂无消息，开始第一句吧';
    if (last) {
      const content = last.attachment ? `[文件] ${last.attachment.original_name}` : last.body;
      preview = conversation.type === 'group' && last.sender.id === state.user.id ? `你：${content}` : content;
    }
    const avatar = conversation.type === 'group'
      ? `<span class="avatar group-avatar">${icon('group')}</span>`
      : avatarHtml(conversation.peer || { display_name: conversation.name });
    return `<button class="conversation-item ${conversation.id === state.activeConversationId ? 'active' : ''}" type="button" data-conversation-id="${conversation.id}">
      ${avatar}<span class="conversation-copy"><span class="conversation-top"><span class="conversation-name">${escapeHtml(conversation.name)}</span><span class="conversation-time">${last ? formatTime(last.created_at) : ''}</span></span>
      <span class="conversation-preview"><p>${escapeHtml(preview)}</p>${conversation.unread ? `<span class="unread-badge">${conversation.unread > 99 ? '99+' : conversation.unread}</span>` : ''}</span></span></button>`;
  }).join('');
}
async function refreshConversations() {
  const data = await api('/conversations');
  state.conversations = data.conversations;
  renderConversations();
  renderNavBadges();
  if (state.activeConversationId && !state.conversations.some((item) => item.id === state.activeConversationId)) {
    closeActiveChat();
    return;
  }
  if (state.activeConversationId) {
    renderChatHeader();
    updateReadStates();
  }
}
async function openConversation(id) {
  state.activeConversationId = Number(id);
  state.typingUser = null;
  clearTimeout(state.typingTimer);
  renderConversations();
  $('#view-chat').classList.add('chat-detail');
  $('#chat-empty').hidden = true;
  $('#chat-active').hidden = false;
  renderChatHeader();
  $('#message-list').innerHTML = '<div class="empty-inline">正在加载消息…</div>';
  try {
    const data = await api(`/conversations/${id}/messages?limit=50`);
    if (state.activeConversationId !== Number(id)) return;
    state.messages = data.messages;
    state.hasMore = data.hasMore;
    renderMessages();
    const conversation = currentConversation();
    if (conversation) conversation.unread = 0;
    renderConversations();
    renderNavBadges();
    await api(`/conversations/${id}/read`, { method: 'POST' });
  } catch (error) {
    $('#message-list').innerHTML = `<div class="empty-inline">${escapeHtml(error.message)}</div>`;
  }
}
function renderChatHeader() {
  const conversation = currentConversation();
  if (!conversation) return;
  const group = conversation.type === 'group';
  const onlineCount = group ? conversation.members.filter((member) => isOnline(member.id)).length : 0;
  const typingName = state.typingUser
    ? (group
      ? conversation.members.find((member) => member.id === state.typingUser)?.display_name
      : conversation.peer?.display_name)
    : null;
  const subtitle = state.typingUser && typingName
    ? `<span class="typing-text">${escapeHtml(typingName)} 正在输入…</span>`
    : group
      ? `${conversation.members.length} 位成员${onlineCount ? ` · ${onlineCount} 人在线` : ''}`
      : (isOnline(conversation.peer?.id) ? '在线' : `@${conversation.peer?.username || ''}`);
  $('#chat-header').innerHTML = `<button class="icon-button chat-back" type="button" data-chat-back aria-label="返回会话列表">${icon('back')}</button>
    ${group ? `<span class="avatar group-avatar">${icon('group')}</span>` : avatarHtml(conversation.peer || { display_name: conversation.name })}
    <div class="chat-header-copy"><h2>${escapeHtml(conversation.name)}</h2><p>${subtitle}</p></div>
    <button class="icon-button" type="button" data-chat-info aria-label="会话详情">${icon('more')}</button>`;
}
function messageHtml(message, previous, showRead = false) {
  const own = message.sender.id === state.user.id;
  const conversation = currentConversation();
  const showDay = !previous || dayLabel(previous.created_at) !== dayLabel(message.created_at);
  const attachment = message.attachment ? `<div class="attachment"><span class="attachment-icon">${icon('file')}</span><span class="attachment-copy"><span class="attachment-name" title="${escapeHtml(message.attachment.original_name)}">${escapeHtml(message.attachment.original_name)}</span><span class="attachment-size">${formatBytes(message.attachment.size)}</span></span><a class="attachment-download" href="${message.attachment.download_url}" download aria-label="下载 ${escapeHtml(message.attachment.original_name)}">${icon('download')}</a></div>` : '';
  const readState = own && showRead && conversation?.type === 'private'
    ? `<span id="read-state" class="read-state">${(conversation.peer_last_read_message_id || 0) >= message.id ? '已读' : '未读'}</span>` : '';
  const recall = own ? `<button class="message-recall" type="button" data-recall-message="${message.id}" title="撤回这条消息">撤回</button>` : '';
  return `${showDay ? `<div class="day-divider">${dayLabel(message.created_at)}</div>` : ''}<div class="message-row ${own ? 'own' : ''}">
    <span class="message-avatar">${avatarHtml(message.sender, 'small')}</span><div class="message-stack">
    ${!own && conversation?.type === 'group' ? `<p class="message-sender">${escapeHtml(message.sender.display_name)}</p>` : ''}
    <div class="message-bubble">${message.body ? `<p class="message-text">${escapeHtml(message.body)}</p>` : ''}${attachment}</div>
    <div class="message-meta">${readState}<span class="message-time-text">${formatTime(message.created_at)}</span>${recall}</div></div></div>`;
}
function updateReadStates() {
  const conversation = currentConversation();
  if (!conversation || conversation.type !== 'private') return;
  const node = $('#read-state');
  if (!node) return;
  const lastOwn = [...state.messages].reverse().find((message) => message.sender.id === state.user.id);
  if (!lastOwn) return;
  node.textContent = (conversation.peer_last_read_message_id || 0) >= lastOwn.id ? '已读' : '未读';
}
function renderMessages() {
  if (!state.messages.length) {
    $('#message-list').innerHTML = '<div class="empty-state"><div class="empty-illustration">' + icon('chat') + '</div><h2>还没有消息</h2><p>发一句问候，开启这段对话。</p></div>';
    return;
  }
  const conversation = currentConversation();
  const lastOwnId = conversation?.type === 'private'
    ? [...state.messages].reverse().find((message) => message.sender.id === state.user.id)?.id : null;
  const olderButton = state.hasMore ? '<button id="load-older" class="button button-secondary button-full" type="button">加载更早的消息</button>' : '';
  $('#message-list').innerHTML = olderButton + state.messages.map((message, index) => messageHtml(message, state.messages[index - 1], message.id === lastOwnId)).join('');
  const list = $('#message-list');
  list.scrollTop = list.scrollHeight;
}
function appendMessage(message) {
  if (state.messages.some((item) => item.id === message.id)) return;
  state.messages.push(message);
  state.messages.sort((a, b) => a.id - b.id);
  renderMessages();
}
async function sendTextMessage(event) {
  event.preventDefault();
  const input = $('#message-input');
  const body = input.value.trim();
  if (!body || !state.activeConversationId) return;
  const button = $('#message-send');
  button.disabled = true;
  try {
    const data = await api(`/conversations/${state.activeConversationId}/messages`, { method: 'POST', body: { body } });
    input.value = '';
    input.style.height = 'auto';
    stopTyping();
    appendMessage(data.message);
    await refreshConversations();
  } catch (error) { showToast(error.message, 'error'); }
  finally { button.disabled = false; input.focus(); }
}
async function sendChatFile(file) {
  if (!file || !state.activeConversationId) return;
  if (file.size > 25 * 1024 * 1024) return showToast('单个文件不能超过 25 MB', 'error');
  const form = new FormData();
  form.append('file', file);
  const draft = $('#message-input').value.trim();
  if (draft) form.append('body', draft);
  showToast(`正在发送 ${file.name}`);
  try {
    const data = await api(`/conversations/${state.activeConversationId}/files`, { method: 'POST', body: form });
    $('#message-input').value = '';
    appendMessage(data.message);
    await refreshConversations();
    showToast('文件已发送');
  } catch (error) { showToast(error.message, 'error'); }
  finally { $('#chat-file-input').value = ''; }
}
async function loadOlderMessages() {
  if (!state.messages.length || state.loadingOlder) return;
  state.loadingOlder = true;
  const list = $('#message-list');
  const oldHeight = list.scrollHeight;
  try {
    const data = await api(`/conversations/${state.activeConversationId}/messages?limit=50&before=${state.messages[0].id}`);
    state.messages = [...data.messages, ...state.messages];
    state.hasMore = data.hasMore;
    renderMessages();
    list.scrollTop = list.scrollHeight - oldHeight;
  } catch (error) { showToast(error.message, 'error'); }
  finally { state.loadingOlder = false; }
}
async function recallMessage(messageId) {
  const message = state.messages.find((item) => item.id === messageId);
  if (!message) return;
  openConfirm('撤回消息', `确定撤回这条消息吗？${message.attachment ? '消息里的附件也会一并删除。' : ''}此操作无法撤销。`, async () => {
    await api(`/conversations/${state.activeConversationId}/messages/${messageId}`, { method: 'DELETE' });
    state.messages = state.messages.filter((item) => item.id !== messageId);
    renderMessages();
    await refreshConversations();
    showToast('消息已撤回');
  });
}
function closeActiveChat() {
  state.activeConversationId = null;
  state.typingUser = null;
  clearTimeout(state.typingTimer);
  $('#chat-active').hidden = true;
  $('#chat-empty').hidden = false;
  $('#view-chat').classList.remove('chat-detail');
}
let typingLastSent = 0;
let typingActive = false;
function emitTyping() {
  if (!state.socket || !state.activeConversationId) return;
  const hasText = $('#message-input').value.trim().length > 0;
  const current = Date.now();
  if (hasText && (!typingActive || current - typingLastSent > 2000)) {
    typingActive = true;
    typingLastSent = current;
    state.socket.emit('typing', { conversationId: state.activeConversationId, typing: true });
  }
  if (!hasText && typingActive) {
    typingActive = false;
    state.socket.emit('typing', { conversationId: state.activeConversationId, typing: false });
  }
}
function stopTyping() {
  if (!state.socket || !typingActive) return;
  typingActive = false;
  state.socket.emit('typing', { conversationId: state.activeConversationId, typing: false });
}

function renderContacts() {
  const friends = state.friends;
  $('#friend-summary').textContent = `${friends.length} 位好友 · ${friends.filter((friend) => isOnline(friend.id)).length} 人在线`;
  $('#request-count').textContent = `${state.requests.incoming.length} 条待处理`;
  $('#friends-list').innerHTML = friends.length ? friends.map((friend) => `<div class="friend-row">${avatarHtml(friend)}<div class="person-copy"><strong>${escapeHtml(friend.display_name)}</strong><span>@${escapeHtml(friend.username)}</span></div><span class="status-label ${isOnline(friend.id) ? 'online' : ''}">${isOnline(friend.id) ? '在线' : '离线'}</span><div class="person-actions"><button class="button button-secondary" type="button" data-message-friend="${friend.id}">发消息</button></div></div>`).join('') : '<div class="empty-inline"><strong>还没有好友</strong><span>搜索用户名，发送第一个好友请求吧</span></div>';
  const incoming = state.requests.incoming.map((request) => `<div class="request-row">${avatarHtml(request)}<div class="person-copy"><strong>${escapeHtml(request.display_name)}</strong><span>@${escapeHtml(request.username)} 请求添加你为好友</span></div><div class="person-actions"><button class="button button-primary" type="button" data-accept-request="${request.id}">接受</button><button class="button button-secondary" type="button" data-decline-request="${request.id}">忽略</button></div></div>`).join('');
  const outgoing = state.requests.outgoing.map((request) => `<div class="request-row">${avatarHtml(request)}<div class="person-copy"><strong>${escapeHtml(request.display_name)}</strong><span>@${escapeHtml(request.username)}</span></div><span class="status-label">等待接受</span></div>`).join('');
  $('#friend-requests').innerHTML = incoming + outgoing;
  renderNavBadges();
}
async function refreshFriends() {
  const data = await api('/friends');
  state.friends = data.friends;
  state.requests = data.requests;
  renderContacts();
}
async function sendFriendRequest(username) {
  if (!username.trim()) return showToast('请输入要添加的用户名', 'error');
  try {
    const data = await api('/friends/requests', { method: 'POST', body: { username: username.trim() } });
    showToast(data.message);
    $('#friend-search').value = '';
    state.searchUsers = [];
    renderUserSearchResults();
    await refreshFriends();
  } catch (error) { showToast(error.message, 'error'); }
}
function renderUserSearchResults() {
  $('#user-search-results').innerHTML = state.searchUsers.map((user) => `<div class="search-user-row">${avatarHtml(user, 'small')}<div class="person-copy"><strong>${escapeHtml(user.display_name)}</strong><span>@${escapeHtml(user.username)}</span></div><div class="person-actions">${user.isFriend ? `<button class="button button-secondary" type="button" data-message-friend="${user.id}">发消息</button>` : user.requestPending ? '<span class="status-label">请求待处理</span>' : `<button class="button button-secondary" type="button" data-add-username="${escapeHtml(user.username)}">加好友</button>`}</div></div>`).join('');
}
async function handleFriendAction(id, action) {
  try {
    await api(`/friends/requests/${id}/${action}`, { method: 'POST' });
    showToast(action === 'accept' ? '已接受好友请求' : '已忽略好友请求');
    await refreshFriends();
  } catch (error) { showToast(error.message, 'error'); }
}
async function startPrivateChat(friendId) {
  try {
    const data = await api('/conversations/private', { method: 'POST', body: { userId: Number(friendId) } });
    await refreshConversations();
    switchView('chat', false);
    await openConversation(data.conversation.id);
  } catch (error) { showToast(error.message, 'error'); }
}
function openGroupModal() {
  if (!state.friends.length) return showToast('先添加一位好友，再创建群聊', 'error');
  openModal('新建群聊', `<form id="group-form" class="modal-form"><label class="field-label" for="group-name">群名称</label><input id="group-name" class="plain-input" maxlength="30" placeholder="例如：周末游戏搭子" required><label class="field-label">选择好友</label><div class="friend-check-list">${state.friends.map((friend) => `<label class="friend-check"><input type="checkbox" value="${friend.id}">${avatarHtml(friend, 'small')}<span>${escapeHtml(friend.display_name)}<small class="muted"> @${escapeHtml(friend.username)}</small></span></label>`).join('')}</div><div class="modal-actions"><button class="button button-secondary" type="button" data-modal-cancel>取消</button><button class="button button-primary" type="submit">创建群聊</button></div></form>`);
  $('[data-modal-cancel]').addEventListener('click', closeModal);
  $('#group-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('button[type="submit"]', event.currentTarget);
    const name = $('#group-name').value.trim();
    const memberIds = $$('input[type="checkbox"]:checked', event.currentTarget).map((input) => Number(input.value));
    if (!memberIds.length) return showToast('请至少选择一位好友', 'error');
    setBusy(button, true, '正在创建…');
    try {
      const data = await api('/conversations/group', { method: 'POST', body: { name, memberIds } });
      closeModal();
      await refreshConversations();
      switchView('chat', false);
      await openConversation(data.conversation.id);
      showToast('群聊已创建');
    } catch (error) { showToast(error.message, 'error'); setBusy(button, false); }
  });
}
function openConversationInfo() {
  const conversation = currentConversation();
  if (!conversation) return;
  if (conversation.type === 'private') {
    const peer = conversation.peer;
    openModal('联系人信息', `<div class="friend-row">${avatarHtml(peer, 'large')}<div class="person-copy"><strong>${escapeHtml(conversation.name)}</strong><span>@${escapeHtml(peer?.username || '')}</span></div></div><p class="muted">${isOnline(peer?.id) ? '当前在线' : '当前离线'}。你们可以私聊并互发文件，附件仅会话成员可下载。</p>`);
    return;
  }
  const isOwner = conversation.owner_id === state.user.id;
  const memberIds = conversation.members.map((member) => member.id);
  const candidates = state.friends.filter((friend) => !memberIds.includes(friend.id));
  const addForm = isOwner && candidates.length ? `<form id="add-member-form" class="add-friend-form"><select id="add-member-select" class="plain-input">${candidates.map((friend) => `<option value="${friend.id}">${escapeHtml(friend.display_name)} (@${escapeHtml(friend.username)})</option>`).join('')}</select><button class="button button-primary" type="submit">添加成员</button></form>` : '';
  const memberRows = conversation.members.map((member) => {
    const label = member.role === 'owner' ? '群主' : isOnline(member.id) ? '在线' : '离线';
    const remove = isOwner && member.id !== state.user.id
      ? `<button class="button button-danger button-small" type="button" data-remove-member="${member.id}" data-remove-name="${escapeHtml(member.display_name)}">移出</button>` : '';
    return `<div class="friend-row">${avatarHtml(member, 'small')}<div class="person-copy"><strong>${escapeHtml(member.display_name)}</strong><span>@${escapeHtml(member.username)}</span></div><div class="person-actions"><span class="status-label ${isOnline(member.id) && member.role !== 'owner' ? 'online' : ''}">${label}</span>${remove}</div></div>`;
  }).join('');
  openModal('群聊详情', `<h3>${escapeHtml(conversation.name)}</h3><p class="muted">${conversation.members.length} 位成员</p><div class="friend-check-list">${memberRows}</div>${addForm}
    <div class="modal-actions"><button id="modal-leave-group" class="button button-danger" type="button">退出群聊</button></div>
    <p class="muted footnote">${isOwner ? '你是群主，退出后群主将转让给群内其他成员。' : '退出后不再接收该群消息。'}</p>`);
  $('#add-member-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api(`/conversations/${conversation.id}/members`, { method: 'POST', body: { userId: Number($('#add-member-select').value) } });
      closeModal();
      await refreshConversations();
      showToast('成员已添加');
    } catch (error) { showToast(error.message, 'error'); }
  });
  $$('[data-remove-member]').forEach((button) => button.addEventListener('click', () => {
    const memberId = Number(button.dataset.removeMember);
    openConfirm('移出群聊', `确定将「${button.dataset.removeName}」移出群聊吗？对方将不再接收该群消息。`, async () => {
      await api(`/conversations/${conversation.id}/members/${memberId}`, { method: 'DELETE' });
      closeModal();
      await refreshConversations();
      showToast('成员已移出');
    });
  }));
  $('#modal-leave-group').addEventListener('click', () => {
    openConfirm('退出群聊', isOwner
      ? '你是群主，退出后群主将转让给群内其他成员。确定退出吗？'
      : '确定退出这个群聊吗？', async () => {
      await api(`/conversations/${conversation.id}/leave`, { method: 'POST' });
      closeModal();
      closeActiveChat();
      await refreshConversations();
      showToast('已退出群聊');
    });
  });
}

async function loadFiles() {
  const data = await api('/files');
  state.fileData = data;
  renderFiles();
}
function renderFiles() {
  const { files, used, limit } = state.fileData;
  const query = ($('#file-search')?.value || '').trim().toLowerCase();
  const visible = files.filter((file) =>
    (!query || file.original_name.toLowerCase().includes(query)) &&
    (state.fileFilter === 'all' || (state.fileFilter === 'shared') === Boolean(file.shared))
  );
  const percent = Math.min((used / limit) * 100, 100);
  $('#storage-text').textContent = `已使用 ${formatBytes(used)}，共 ${formatBytes(limit)}`;
  $('#storage-bar').style.width = `${percent}%`;
  $('#file-count').textContent = visible.length === files.length
    ? `${files.length} 个文件`
    : `${visible.length} / ${files.length} 个文件`;
  const emptyMessage = files.length
    ? { strong: '没有匹配的文件', span: '换个关键词或筛选条件试试' }
    : { strong: '文件空间还是空的', span: '上传一个文件，然后在另一台设备登录同一账号下载' };
  $('#files-list').innerHTML = visible.length ? visible.map((file) => `<div class="file-row"><div class="file-main"><span class="file-type-icon">${icon('file')}</span><div class="file-copy"><span class="file-name" title="${escapeHtml(file.original_name)}">${escapeHtml(file.original_name)}</span><div class="file-meta"><span>${formatBytes(file.size)}</span><span>${formatFullDate(file.created_at)}</span>${file.shared ? '<span class="shared-tag">聊天附件</span>' : '<span>个人文件</span>'}</div></div></div><div class="file-actions"><a class="icon-button" href="${file.download_url}" download aria-label="下载 ${escapeHtml(file.original_name)}" title="下载">${icon('download')}</a>${file.deletable ? `<button class="icon-button danger-icon" type="button" data-delete-file="${file.id}" aria-label="删除 ${escapeHtml(file.original_name)}" title="删除">${icon('trash')}</button>` : ''}</div></div>`).join('') : `<div class="empty-inline"><strong>${emptyMessage.strong}</strong><span>${emptyMessage.span}</span></div>`;
}
async function uploadPersonalFile(file) {
  if (!file) return;
  if (file.size > 25 * 1024 * 1024) throw new Error(`「${file.name}」超过 25 MB，未上传`);
  const form = new FormData();
  form.append('file', file);
  await api('/files', { method: 'POST', body: form });
}
async function uploadPersonalFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  let completed = 0;
  for (const file of files) {
    try { await uploadPersonalFile(file); completed += 1; }
    catch (error) { showToast(error.message, 'error'); }
  }
  if (completed) showToast(`已上传 ${completed} 个文件，可在其他设备下载`);
  $('#personal-file-input').value = '';
  await loadFiles();
}

const CLOUD_FAVORITE_CATEGORY = 'favorites';

/* ---------- 朋友圈 ---------- */
function momentTimeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 7 * 86400000) return `${Math.floor(diff / 86400000)} 天前`;
  return new Date(iso).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
}
function momentVisibilityLabel(visibility) {
  return { friends: '好友可见', private: '仅自己可见', public: '站内公开' }[visibility] || '好友可见';
}
function momentVisibilityIcon(visibility) {
  return visibility === 'private' ? 'lock' : visibility === 'public' ? 'globe' : 'users';
}
function readMomentsSeen() {
  try { return Number(localStorage.getItem(MOMENTS_SEEN_KEY)) || 0; } catch { return 0; }
}
function markMomentsSeen() {
  try { localStorage.setItem(MOMENTS_SEEN_KEY, String(state.momentsLatestId || readMomentsSeen())); } catch { /* 忽略 */ }
  $('#nav-moments').hidden = true;
}
function renderMomentsBadge() {
  const hasNewMoments = state.momentsLatestId > readMomentsSeen();
  $('#nav-moments').hidden = state.view === 'moments' || (!hasNewMoments && !state.momentUnread);
}
function updateMomentsBadge(latestId) {
  state.momentsLatestId = latestId || 0;
  renderMomentsBadge();
  if (state.view === 'moments') markMomentsSeen();
}
function readMomentActivitySeen() {
  try { return localStorage.getItem(MOMENT_ACTIVITY_SEEN_KEY) || ''; } catch { return ''; }
}
function renderMomentNoticeButton() {
  const badge = $('#moments-notice-badge');
  badge.textContent = state.momentUnread > 9 ? '9+' : String(state.momentUnread);
  badge.hidden = state.momentUnread === 0;
}
async function loadMomentNotifications() {
  try {
    const data = await api('/moments/notifications');
    state.momentNotifications = data.notifications;
    const seen = readMomentActivitySeen();
    state.momentUnread = seen
      ? data.notifications.filter((notice) => notice.created_at > seen).length
      : data.notifications.length;
    renderMomentNoticeButton();
    renderMomentsBadge();
  } catch { /* 通知不可用时不打扰主流程 */ }
}
function markMomentActivitySeen() {
  try {
    localStorage.setItem(MOMENT_ACTIVITY_SEEN_KEY,
      state.momentNotifications[0]?.created_at || new Date().toISOString());
  } catch { /* 忽略 */ }
  state.momentUnread = 0;
  renderMomentNoticeButton();
  renderMomentsBadge();
}
function openMomentNotifications() {
  const list = state.momentNotifications.length
    ? state.momentNotifications.map((notice) => `<div class="moment-notice-row">
        <span class="avatar small" style="background:${escapeHtml(notice.avatar_color)}">${escapeHtml(initial(notice.display_name))}</span>
        <div class="moment-notice-copy">
          <strong>${escapeHtml(notice.display_name)}</strong><span>${notice.type === 'like' ? '赞了你的动态' : '评论了你的动态'}</span>
          ${notice.type === 'comment' ? `<p class="moment-notice-quote">${escapeHtml(notice.body)}</p>` : ''}
          <p class="moment-notice-origin">${escapeHtml(notice.moment_body || '图片动态')}</p>
        </div><span class="moment-notice-time">${momentTimeAgo(notice.created_at)}</span>
      </div>`).join('')
    : '<div class="empty-inline"><strong>还没有新消息</strong><span>朋友点赞或评论后会出现在这里</span></div>';
  openModal('新消息', `<div class="moment-notice-list">${list}</div><div class="modal-actions"><button id="moment-notice-read" class="button button-primary" type="button">全部标为已读</button></div>`);
  $('#moment-notice-read').addEventListener('click', () => {
    markMomentActivitySeen();
    closeModal();
    showToast('已标为已读');
  });
}

async function loadMoments({ before = null, append = false } = {}) {
  if (state.momentsLoading) return;
  state.momentsLoading = true;
  const moreButton = $('#moments-more');
  if (before) setBusy(moreButton, true, '加载中…');
  try {
    const data = await api(`/moments${before ? `?before=${before}` : ''}`);
    state.moments = append ? [...state.moments, ...data.moments] : data.moments;
    state.momentsHasMore = data.hasMore;
    renderMoments();
    updateMomentsBadge(data.latestId);
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    state.momentsLoading = false;
    if (before) setBusy(moreButton, false);
  }
}

function renderMomentsCover() {
  if (!state.user) return;
  $('#moments-cover-user').innerHTML = `${avatarHtml(state.user, 'large')}<div><strong>${escapeHtml(state.user.display_name)}</strong><span>@${escapeHtml(state.user.username)}</span></div>`;
  $('#composer-avatar').innerHTML = avatarHtml(state.user, 'small');
}
function renderMomentsFriends() {
  $('#moments-friend-summary').textContent = `${state.friends.length} 位好友`;
  $('#moments-friends').innerHTML = state.friends.length
    ? state.friends.map((friend) => `<div class="moments-friend-row">${avatarHtml(friend, 'small')}<div><strong>${escapeHtml(friend.display_name)}</strong><span>${isOnline(friend.id) ? '在线' : '离线'}</span></div></div>`).join('')
    : '<div class="empty-inline"><strong>还没有好友</strong><span>去联系人页添加，就能看到他们的动态</span></div>';
}
function renderMomentFilters() {
  $$('[data-moment-filter]').forEach((chip) => chip.classList.toggle('active', chip.dataset.momentFilter === state.momentFilter));
}
function visibleMoments() {
  if (state.momentFilter === 'mine') return state.moments.filter((moment) => moment.author.id === state.user.id);
  if (state.momentFilter === 'friends') return state.moments.filter((moment) => moment.author.id !== state.user.id);
  return state.moments;
}
function renderMoments() {
  renderMomentsCover();
  renderMomentsFriends();
  renderMomentFilters();
  const list = visibleMoments();
  $('#moments-count').textContent = `${list.length} 条动态`;
  $('#moments-list').innerHTML = list.map(momentHtml).join('');
  const empty = $('#moments-empty');
  empty.hidden = list.length > 0;
  if (!list.length) {
    const titles = { all: '还没有动态', friends: '好友还没发动态', mine: '你还没发过动态' };
    const hints = { all: '写下第一条，或先去联系人里加几位好友。', friends: '等朋友分享近况，或去看看其他筛选。', mine: '点右上角「发布动态」，记录这一刻。' };
    $('strong', empty).textContent = titles[state.momentFilter];
    $('p', empty).textContent = hints[state.momentFilter];
  }
  $('#moments-more-wrap').hidden = !state.momentsHasMore;
}

function momentHtml(moment) {
  const body = moment.body ? `<p class="moment-body">${escapeHtml(moment.body).replace(/\n/g, '<br>')}</p>` : '';
  const images = moment.images.length
    ? `<div class="moment-grid count-${Math.min(moment.images.length, 9)}">${moment.images.map((image) => `<button class="moment-grid-item" type="button" data-view-image="${image.id}" aria-label="查看图片"><img src="${image.url}" alt="动态图片" loading="lazy"></button>`).join('')}</div>`
    : '';
  const likes = moment.likes.length
    ? `<div class="moment-likes">${icon('heart')}<span>${moment.likes.map((like) => escapeHtml(like.display_name)).join('、')}</span></div>`
    : '';
  const comments = moment.comments.length
    ? `<div class="moment-comments">${moment.comments.map((comment) => `<div class="moment-comment">
        <button class="moment-comment-name" type="button" data-reply-comment="${comment.id}" data-reply-moment="${moment.id}" data-reply-user="${comment.author.id}" data-reply-name="${escapeHtml(comment.author.display_name)}" title="回复 ${escapeHtml(comment.author.display_name)}">${escapeHtml(comment.author.display_name)}</button>${comment.reply_to ? `<span class="moment-reply-word">回复</span><span class="moment-comment-name static">${escapeHtml(comment.reply_to.display_name)}</span>` : ''}<span class="moment-comment-text">：${escapeHtml(comment.body)}</span>${comment.deletable ? `<button class="moment-comment-delete" type="button" data-delete-comment="${comment.id}" data-comment-of="${moment.id}" aria-label="删除评论" title="删除评论">${icon('close')}</button>` : ''}
      </div>`).join('')}</div>`
    : '';
  const open = state.momentCommentOpen.has(moment.id);
  const reply = state.momentReplies[moment.id];
  const commentForm = open
    ? `<form class="moment-comment-form" data-comment-form="${moment.id}">
        <input type="text" maxlength="500" placeholder="${reply ? `回复 ${escapeHtml(reply.name)}：` : '说点什么…'}" aria-label="评论内容">
        <button class="button button-primary button-small" type="submit">发送</button>
        ${reply ? `<button class="text-button moment-reply-cancel" type="button" data-cancel-reply="${moment.id}">取消回复</button>` : ''}
      </form>`
    : '';
  const engagement = likes || comments ? `<div class="moment-engagement">${likes}${comments}</div>` : '';
  return `<article class="moment-card content-card" data-moment-card="${moment.id}">
    <div class="moment-head">
      ${avatarHtml(moment.author)}
      <div class="moment-author"><strong>${escapeHtml(moment.author.display_name)}</strong><span>${icon(momentVisibilityIcon(moment.visibility))}${momentVisibilityLabel(moment.visibility)}</span></div>
      ${moment.can_delete ? `<button class="icon-button danger-icon moment-delete" type="button" data-delete-moment-btn="${moment.id}" aria-label="删除动态" title="删除动态">${icon('trash')}</button>` : ''}
    </div>
    ${body}${images}
    <div class="moment-meta"><span>${momentTimeAgo(moment.created_at)}</span><span class="moment-meta-dot">·</span><span>${moment.comments.length} 条评论 · ${moment.likes.length} 个赞</span></div>
    <div class="moment-actions">
      <button class="moment-action ${moment.liked ? 'liked' : ''}" type="button" data-like-moment="${moment.id}" aria-pressed="${moment.liked}">${icon('heart')}<span>${moment.liked ? '已赞' : '赞'}</span></button>
      <button class="moment-action" type="button" data-comment-moment="${moment.id}">${icon('comment')}<span>${open ? '收起评论' : '评论'}</span></button>
    </div>
    ${engagement}${commentForm}
  </article>`;
}

function renderMomentPreview() {
  const box = $('#moment-image-preview');
  box.hidden = state.momentDraft.length === 0;
  box.innerHTML = state.momentDraft.map((item, index) => `<div class="moment-preview-item"><img src="${item.url}" alt="待发布图片 ${index + 1}"><button class="moment-preview-remove" type="button" data-remove-draft="${index}" aria-label="移除第 ${index + 1} 张图片">${icon('close')}</button></div>`).join('');
}
function addMomentImages(fileList) {
  const accepted = [];
  for (const file of [...fileList]) {
    if (!MOMENT_IMAGE_TYPES.includes(file.type)) { showToast(`「${file.name}」不是支持的图片格式`, 'error'); continue; }
    if (file.size > 5 * 1024 * 1024) { showToast(`「${file.name}」超过 5 MB`, 'error'); continue; }
    accepted.push(file);
  }
  if (!accepted.length) return;
  const room = Math.max(0, 9 - state.momentDraft.length);
  if (accepted.length > room) showToast('最多 9 张图片，多余的图片已忽略', 'error');
  accepted.slice(0, room).forEach((file) => state.momentDraft.push({ file, url: URL.createObjectURL(file) }));
  renderMomentPreview();
}
function clearMomentDraft() {
  state.momentDraft.forEach((item) => URL.revokeObjectURL(item.url));
  state.momentDraft = [];
  $('#moment-text').value = '';
  $('#moment-count').textContent = '0 / 2000';
  renderMomentPreview();
}
async function publishMoment() {
  const text = $('#moment-text').value.trim();
  if (!text && !state.momentDraft.length) return showToast('写点什么，或至少选一张图片', 'error');
  const button = $('#moment-publish');
  setBusy(button, true, '发布中…');
  const form = new FormData();
  form.append('body', text);
  form.append('visibility', $('#moment-visibility').value);
  state.momentDraft.forEach((item) => form.append('images', item.file));
  try {
    await api('/moments', { method: 'POST', body: form });
    clearMomentDraft();
    state.momentFilter = 'all';
    await loadMoments();
    markMomentsSeen();
    showToast('动态已发布');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setBusy(button, false);
  }
}
async function toggleMomentLike(momentId) {
  const moment = state.moments.find((item) => item.id === momentId);
  if (!moment) return;
  try {
    await api(`/moments/${momentId}/like`, { method: moment.liked ? 'DELETE' : 'POST' });
    await loadMoments();
  } catch (error) { showToast(error.message, 'error'); }
}
function focusMomentComment(momentId) {
  const form = $(`[data-comment-form="${momentId}"]`);
  if (form) $('input', form).focus();
}
function openImageViewer(imageId) {
  const image = state.moments.flatMap((moment) => moment.images).find((item) => item.id === Number(imageId));
  if (!image) return;
  $('#image-viewer-img').src = image.url;
  $('#image-viewer').hidden = false;
}
function closeImageViewer() {
  $('#image-viewer').hidden = true;
  $('#image-viewer-img').removeAttribute('src');
}

function cloudMatches(game) {
  const categoryMatch = state.cloudCategory === 'all'
    || (state.cloudCategory === CLOUD_FAVORITE_CATEGORY
      ? state.cloudFavorites.has(game.id)
      : game.category === state.cloudCategory);
  if (!categoryMatch) return false;
  const query = state.cloudQuery.trim().toLowerCase();
  if (!query) return true;
  const haystack = [game.name, game.subtitle, game.description, game.category, ...(game.tags || [])]
    .filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(query);
}
function gameTagsHtml(game) {
  return (game.tags || (game.category ? [game.category] : []))
    .map((tag) => `<span>${escapeHtml(tag)}</span>`).join('');
}
function gameStatusText(game) {
  if (!game.configured) return '服务地址待修正';
  return game.source === 'custom' ? '自建服务已接入' : '官方网页版 · 可开玩';
}
function launchLabel(game) {
  if (!game.configured) return '查看说明';
  return game.source === 'custom' ? '启动' : '立即开玩';
}
function gameCardHtml(game) {
  const favorite = state.cloudFavorites.has(game.id);
  return `<article class="game-card theme-${escapeHtml(game.theme)}" data-open-game="${escapeHtml(game.id)}">
    <div class="game-art">
      <span class="game-orbit"></span><span class="game-orbit small"></span>
      <span class="game-glyph">${escapeHtml(game.mark)}</span>
      <button class="favorite-button ${favorite ? 'active' : ''}" type="button" data-favorite-game="${escapeHtml(game.id)}" aria-pressed="${favorite}" aria-label="${favorite ? '取消收藏' : '收藏'} ${escapeHtml(game.name)}" title="${favorite ? '取消收藏' : '收藏'}">${icon('star')}</button>
    </div>
    <div class="game-body">
      <div class="game-title-row"><h3>${escapeHtml(game.name)}</h3><span class="game-platform">${escapeHtml(game.platform)}</span></div>
      <p class="game-sub">${escapeHtml(game.subtitle)}</p>
      <div class="game-tags">${gameTagsHtml(game)}</div>
    </div>
    <div class="game-foot">
      <span class="game-status ${game.configured ? 'ready' : ''}">${gameStatusText(game)}</span>
      <div class="game-foot-actions">
        <button class="button button-secondary button-small" type="button" data-launch-game="${escapeHtml(game.id)}">${launchLabel(game)}</button>
        <button class="icon-button" type="button" data-open-game="${escapeHtml(game.id)}" aria-label="查看 ${escapeHtml(game.name)} 详情" title="详情">${icon('info')}</button>
      </div>
    </div>
  </article>`;
}
function renderCloudHero() {
  const games = state.games;
  const hero = games.find((game) => game.configured) || games.find((game) => game.featured) || games[0];
  const node = $('#cloud-hero');
  if (!hero) { node.innerHTML = ''; node.className = 'cloud-hero'; return; }
  node.className = `cloud-hero theme-${escapeHtml(hero.theme)}`;
  node.innerHTML = `<div class="hero-copy">
      <span class="hero-badge">${icon('star')}本周推荐</span>
      <h2>${escapeHtml(hero.name)}</h2>
      <p class="hero-sub">${escapeHtml(hero.subtitle)}</p>
      <p class="hero-desc">${escapeHtml(hero.description || '')}</p>
      <div class="hero-meta"><span>${escapeHtml(hero.category)}</span><span>${escapeHtml(hero.platform)}</span><span>${gameStatusText(hero)}</span></div>
      <div class="hero-actions">
        <button class="button hero-primary" type="button" data-launch-game="${escapeHtml(hero.id)}">${icon('play')}${launchLabel(hero)}</button>
        <button class="button hero-secondary" type="button" data-open-game="${escapeHtml(hero.id)}">游戏详情</button>
      </div>
    </div>
    <div class="hero-art" aria-hidden="true"><span class="hero-orbit"></span><span class="hero-orbit two"></span><span class="hero-glyph">${escapeHtml(hero.mark)}</span></div>`;
}
function renderCloudFilters() {
  const categories = [...new Set(state.games.map((game) => game.category).filter(Boolean))];
  const options = [
    { id: 'all', label: '全部' },
    { id: CLOUD_FAVORITE_CATEGORY, label: '收藏' },
    ...categories.map((category) => ({ id: category, label: category }))
  ];
  $('#cloud-filters').innerHTML = options.map((option) => `<button class="chip ${state.cloudCategory === option.id ? 'active' : ''}" type="button" data-cloud-category="${escapeHtml(option.id)}">${escapeHtml(option.label)}</button>`).join('');
}
function cloudTimeAgo(iso) {
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return '';
  const diff = Date.now() - time;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.round(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)} 小时前`;
  return new Date(iso).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}
function cloudRecentEntries() {
  const seen = new Set();
  return state.cloudRecent
    .map((entry) => {
      const id = typeof entry === 'string' ? entry : entry?.id;
      const at = typeof entry === 'string' ? null : entry?.at;
      return { id, at, game: state.games.find((game) => game.id === id) };
    })
    .filter((entry) => {
      if (!entry.game || seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    })
    .slice(0, 4);
}
function renderCloudRecent() {
  const entries = cloudRecentEntries();
  $('#cloud-recent-wrap').hidden = entries.length === 0;
  $('#cloud-recent').innerHTML = entries.map(({ game, at }) => `<button class="recent-chip theme-${escapeHtml(game.theme)}" type="button" data-open-game="${escapeHtml(game.id)}">
      <span class="recent-mark">${escapeHtml(game.mark)}</span><span>${escapeHtml(game.name)}</span>${at ? `<span class="recent-time">${cloudTimeAgo(at)}</span>` : ''}
    </button>`).join('');
}
function markCloudRecent(gameId) {
  const list = state.cloudRecent
    .map((entry) => (typeof entry === 'string' ? { id: entry, at: null } : entry))
    .filter((entry) => entry?.id && entry.id !== gameId);
  list.unshift({ id: gameId, at: new Date().toISOString() });
  state.cloudRecent = list.slice(0, 4);
  writeStoredList(CLOUD_RECENT_KEY, state.cloudRecent);
}
function renderGames() {
  renderCloudHero();
  renderCloudFilters();
  renderCloudRecent();
  const list = state.games.filter(cloudMatches);
  $('#games-list').innerHTML = list.map(gameCardHtml).join('');
  $('#games-list').hidden = list.length === 0;
  $('#cloud-empty').hidden = list.length > 0;
}
function toggleCloudFavorite(gameId) {
  const active = !state.cloudFavorites.has(gameId);
  if (active) state.cloudFavorites.add(gameId); else state.cloudFavorites.delete(gameId);
  writeStoredList(CLOUD_FAVORITES_KEY, [...state.cloudFavorites]);
  return active;
}
function openGameDetail(gameId) {
  const game = state.games.find((item) => item.id === gameId);
  if (!game) return;
  markCloudRecent(game.id);
  renderCloudRecent();
  const favorite = state.cloudFavorites.has(game.id);
  const playMode = game.source === 'custom'
    ? (game.mode === 'iframe' ? '站内嵌入游玩' : '新标签页打开')
    : '官方网页版（新标签页）';
  openModal(game.name, `<div class="game-detail-hero theme-${escapeHtml(game.theme)}">
      <span class="game-detail-mark">${escapeHtml(game.mark)}</span>
      <div class="game-detail-heading"><h3>${escapeHtml(game.cloudName || game.name)}</h3><p>${escapeHtml(game.subtitle)}</p></div>
    </div>
    <p class="game-detail-desc">${escapeHtml(game.description || '')}</p>
    <div class="detail-tags">${gameTagsHtml(game)}</div>
    <div class="detail-info">
      <div><span>云游戏服务</span><strong>${escapeHtml(game.provider)}</strong></div>
      <div><span>官方域名</span><strong class="detail-host">${escapeHtml(game.officialHost)}</strong></div>
      <div><span>游戏账号</span><strong>${escapeHtml(game.account)}</strong></div>
      <div><span>游玩方式</span><strong>${escapeHtml(playMode)}</strong></div>
      <div><span>游戏免登</span><strong>${game.ssoConfigured ? '自建服务已支持 SSO' : '不支持，需登录游戏账号'}</strong></div>
    </div>
    <a class="detail-official-link" href="${escapeHtml(game.officialUrl)}" target="_blank" rel="noopener noreferrer">${icon('external')}先核对官方网页版入口</a>
    <div class="detail-notes">
      <p><strong>时长</strong>${escapeHtml(game.freeTime || '')}</p>
      <p><strong>浏览器</strong>${escapeHtml(game.browserHint || '')}</p>
      <p class="muted">云屿不会收集或转发游戏账号密码。网站登录状态保留 30 天，但不等于游戏免登。</p>
    </div>
    <div class="modal-actions modal-actions-split">
      <button id="detail-favorite" class="button button-secondary" type="button" aria-pressed="${favorite}">${icon('star')}<span>${favorite ? '取消收藏' : '收藏'}</span></button>
      <button id="detail-launch" class="button button-primary" type="button">${icon('play')}${launchLabel(game)}</button>
    </div>`);
  $('#detail-favorite').addEventListener('click', (event) => {
    const active = toggleCloudFavorite(game.id);
    const button = event.currentTarget;
    button.setAttribute('aria-pressed', String(active));
    $('span', button).textContent = active ? '取消收藏' : '收藏';
    renderGames();
    showToast(active ? '已加入收藏' : '已取消收藏');
  });
  $('#detail-launch').addEventListener('click', () => {
    if (game.configured) { closeModal(); launchGame(game.id); }
    else openCloudInfo(game);
  });
}
function openCloudInfo(game) {
  const hosts = state.games.map((item) => `${item.cloudName || item.name}  ${item.officialHost}`).join('\n');
  const envKey = game ? GAME_ENV_KEYS[game.id] : 'CLOUD_GENSHIN_URL';
  const envPrefix = envKey.replace(/_URL$/, '');
  const envText = game
    ? `${envKey}=https://你的自建云游戏服务地址\n# 仅当服务由你部署、且允许被嵌入时开启：\n${envPrefix}_EMBED=1\n# 仅当服务确实支持单点登录时开启：\n${envPrefix}_SSO=1`
    : 'CLOUD_GENSHIN_URL=https://你的自建云游戏服务地址\nCLOUD_GENSHIN_EMBED=1';
  openModal(game ? `${game.name} · 游玩须知` : '云游戏游玩须知', `<p><strong>可以真玩。</strong>大厅里的四款游戏都直连厂商官方云游戏网页版：点「立即开玩」会在新标签页打开官方页面，用自己的游戏账号登录后即可游玩，进度与官方客户端互通。</p>
    <ol class="info-list">
      <li>登录与串流全部由厂商官方页面完成，云屿只负责打开入口，不代理游戏流量。</li>
      <li>游戏账号需在官方页面登录；厂商未向第三方网站开放 SSO，云屿账号无法免登游戏。</li>
      <li>官方页面设置了 X-Frame-Options: DENY，禁止被第三方站点嵌入，因此游戏画面在独立标签页运行。</li>
      <li>免费时长、畅玩卡、排队与画质都由官方服务控制，云屿不提供也不绕过任何计费机制。</li>
      <li>云屿不索取、不保存、不转发游戏账号与密码。</li>
    </ol>
    <p class="info-subtitle">认准官方域名，避免钓鱼站</p><p class="code-note">${escapeHtml(hosts)}</p>
    <p class="info-subtitle">自建 / 已授权云游戏服务</p>
    <p class="muted">如果你拥有 GPU 串流服务或已获授权的服务地址，可用环境变量替换官方入口；开启 EMBED 后游戏画面可在站内直接运行。</p>
    <p class="code-note">${escapeHtml(envText)}</p>
    <p class="muted footnote">网站登录状态保留 30 天；游戏是否免登始终由厂商授权结果决定。</p>`);
}

function closeLaunchOverlay() {
  const node = $('#cloud-launch');
  node.hidden = true;
  node.innerHTML = '';
  document.body.classList.remove('launch-open');
}

function renderLaunchOverlay(game, result) {
  const node = $('#cloud-launch');
  const official = result.source === 'official';
  const embedded = result.mode === 'iframe';
  const steps = official
    ? [
        ['01', '已打开官方页面', `新标签页正在加载 ${result.officialHost}；若被浏览器拦截，可点下方按钮重新打开。`],
        ['02', '登录游戏账号', `在官方页面用${game.account}登录，云屿不会代你登录或保存密码。`],
        ['03', '开始游玩', '领取免费时长或购买畅玩卡，按 F11 全屏，游戏进度与客户端互通。']
      ]
    : [
        ['01', '已连接服务', '云游戏服务由部署者配置，画面与账号均由该服务提供。'],
        ['02', '按需登录', result.requiresGameLogin ? '该服务未开启单点登录，请在页面中自行登录。' : '服务已开启单点登录，免登结果以服务返回为准。'],
        ['03', '开始游玩', '按 F11 或在页面内进入全屏，随时可关闭启动台返回大厅。']
      ];
  node.className = `cloud-launch theme-${escapeHtml(game.theme)}`;
  node.innerHTML = `<div class="launch-shell">
      <div class="launch-top"><span class="launch-badge">${icon('game')}${official ? '厂商官方云游戏' : '自建云游戏服务'}</span><button class="launch-close icon-button" type="button" data-launch-close aria-label="关闭启动面板">${icon('close')}</button></div>
      ${embedded
        ? `<div class="launch-embed"><iframe src="${escapeHtml(result.launchUrl)}" title="${escapeHtml(result.name)}" allow="fullscreen; autoplay; gamepad; pointer-lock; clipboard-write" referrerpolicy="no-referrer"></iframe></div>`
        : `<div class="launch-main">
          <span class="launch-glyph" aria-hidden="true">${escapeHtml(game.mark)}</span>
          <p class="launch-kicker">${escapeHtml(game.provider)} · ${escapeHtml(result.name)}</p>
          <h2 id="launch-title">${official ? '已在新标签页打开' : '服务已就绪'}</h2>
          <p class="launch-lead">${official ? '切到刚打开的标签页，用游戏账号登录即可开玩。这个面板会留在云屿，方便你随时切回来。' : '云游戏服务已连接，点击下方按钮开始游玩。'}</p>
          ${official ? `<div class="launch-host">${icon('shield')}<span>请核对官方域名</span><strong>${escapeHtml(result.officialHost)}</strong></div>` : ''}
          <div class="launch-steps">${steps.map(([num, title, text]) => `<div class="launch-step"><span>${num}</span><div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(text)}</p></div></div>`).join('')}</div>
          <p class="launch-tip">${escapeHtml(game.browserHint || '')}</p>
          <p class="launch-tip">${escapeHtml(game.freeTime || '')}</p>
          <div class="launch-actions">
            <a class="button button-primary" href="${escapeHtml(result.launchUrl)}" target="_blank" rel="noopener noreferrer">${icon('external')}${official ? '重新打开官方页面' : '打开云游戏服务'}</a>
            <button class="button button-secondary" type="button" data-launch-close>返回大厅</button>
          </div>
        </div>`}
    </div>`;
  node.hidden = false;
  document.body.classList.add('launch-open');
  node.querySelector('[data-launch-close]')?.focus();
}

async function launchGame(gameId) {
  const game = state.games.find((item) => item.id === gameId);
  if (!game) return;
  if (!game.configured) return openCloudInfo(game);
  // 必须在用户手势的同步阶段打开窗口，否则异步请求完成后会被弹窗拦截器拦下。
  let popup = null;
  if (game.mode !== 'iframe') {
    try {
      popup = window.open('', '_blank');
      if (popup) popup.opener = null;
    } catch { popup = null; }
  }
  try {
    const data = await api(`/cloud/games/${gameId}/launch`, { method: 'POST' });
    if (data.mode !== 'iframe') {
      if (popup && !popup.closed) popup.location.replace(data.launchUrl);
      else popup?.close();
    }
    markCloudRecent(game.id);
    renderGames();
    renderLaunchOverlay(game, data);
    if (data.mode !== 'iframe' && !popup) showToast('浏览器拦截了新窗口，请在启动面板中点击「重新打开」', 'error');
    else showToast(data.message);
  } catch (error) {
    popup?.close();
    showToast(error.message, 'error');
  }
}

function connectSocket() {
  state.socket?.disconnect();
  if (typeof io !== 'function') return showToast('实时连接组件未加载，消息仍可在刷新后查看', 'error');
  state.socket = io({ transports: ['websocket', 'polling'] });
  state.socket.on('presence:update', ({ onlineUserIds }) => {
    state.onlineUserIds = new Set(onlineUserIds);
    renderConversations();
    renderContacts();
    if (state.activeConversationId) renderChatHeader();
  });
  state.socket.on('message:new', async ({ message }) => {
    if (message.conversation_id === state.activeConversationId && state.view === 'chat') {
      appendMessage(message);
      const conversation = currentConversation();
      if (conversation) conversation.unread = 0;
      api(`/conversations/${message.conversation_id}/read`, { method: 'POST' }).catch(() => {});
    }
    await refreshConversations().catch(() => {});
  });
  state.socket.on('message:deleted', async ({ conversationId, messageId }) => {
    if (conversationId === state.activeConversationId) {
      state.messages = state.messages.filter((message) => message.id !== messageId);
      renderMessages();
    }
    await refreshConversations().catch(() => {});
  });
  state.socket.on('message:read', ({ conversationId, userId, lastReadMessageId }) => {
    if (userId === state.user.id) return;
    const conversation = state.conversations.find((item) => item.id === conversationId);
    if (conversation?.type === 'private') {
      conversation.peer_last_read_message_id = lastReadMessageId;
      if (conversationId === state.activeConversationId) updateReadStates();
    }
  });
  state.socket.on('conversation:typing', ({ conversationId, userId, typing }) => {
    if (conversationId !== state.activeConversationId) return;
    clearTimeout(state.typingTimer);
    if (typing) {
      state.typingUser = userId;
      state.typingTimer = setTimeout(() => {
        state.typingUser = null;
        renderChatHeader();
      }, 4000);
    } else {
      state.typingUser = null;
    }
    renderChatHeader();
  });
  state.socket.on('profile:updated', ({ user }) => {
    if (user?.id !== state.user.id) return;
    state.user = user;
    $('#user-menu-button').textContent = initial(state.user.display_name);
    $('#user-menu-button').style.background = state.user.avatar_color;
    if (state.view === 'moments') renderMomentsCover();
  });
  state.socket.on('friends:changed', () => refreshFriends().then(() => {
    if (state.view === 'moments') { renderMomentsFriends(); loadMoments(); }
  }).catch(() => {}));
  state.socket.on('moments:changed', ({ momentId }) => {
    if (state.view === 'moments') { loadMoments(); return; }
    if (Number(momentId) > readMomentsSeen()) $('#nav-moments').hidden = false;
  });
  state.socket.on('moments:activity', () => loadMomentNotifications());
  state.socket.on('conversation:new', () => refreshConversations().catch(() => {}));
  state.socket.on('connect_error', () => {});
}
function openUserMenu() {
  if (!state.user) return;
  openModal('我的账号', `<div class="friend-row">${avatarHtml(state.user, 'large')}<div class="person-copy"><strong>${escapeHtml(state.user.display_name)}</strong><span>@${escapeHtml(state.user.username)}</span></div></div><p class="muted">本设备的网站登录状态保留 30 天。换设备时需要重新登录网站，但可查看同一账号下的会话和文件。</p><div class="modal-actions modal-actions-split"><button id="modal-edit-profile" class="button button-secondary" type="button">${icon('edit')}编辑资料</button><button id="modal-logout" class="button button-danger" type="button">${icon('logout')}退出登录</button></div>`);
  $('#modal-edit-profile').addEventListener('click', openProfileModal);
  $('#modal-logout').addEventListener('click', logout);
}
function openProfileModal() {
  openModal('编辑资料', `<form id="profile-form" class="modal-form">
    <label class="field-label" for="profile-name">昵称</label>
    <input id="profile-name" class="plain-input" maxlength="30" value="${escapeHtml(state.user.display_name)}" required>
    <label class="field-label">头像颜色</label>
    <div class="color-swatches">${PROFILE_COLORS.map((color) => `<label class="color-swatch ${color === state.user.avatar_color ? 'active' : ''}"><input type="radio" name="avatar-color" value="${color}" ${color === state.user.avatar_color ? 'checked' : ''}><span class="swatch" style="background:${color}"></span></label>`).join('')}</div>
    <div class="modal-actions"><button class="button button-secondary" type="button" data-modal-cancel>取消</button><button class="button button-primary" type="submit">保存</button></div>
  </form>`);
  $('[data-modal-cancel]').addEventListener('click', closeModal);
  $$('.color-swatch').forEach((swatch) => swatch.addEventListener('click', () => {
    $$('.color-swatch').forEach((item) => item.classList.remove('active'));
    swatch.classList.add('active');
  }));
  $('#profile-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('button[type="submit"]', event.currentTarget);
    const display_name = $('#profile-name').value.trim();
    const avatar_color = $('input[name="avatar-color"]:checked')?.value || state.user.avatar_color;
    setBusy(button, true, '正在保存…');
    try {
      const data = await api('/me', { method: 'PATCH', body: { display_name, avatar_color } });
      state.user = data.user;
      $('#user-menu-button').textContent = initial(state.user.display_name);
      $('#user-menu-button').style.background = state.user.avatar_color;
      closeModal();
      await refreshConversations();
      renderContacts();
      showToast('资料已更新');
    } catch (error) {
      showToast(error.message, 'error');
      setBusy(button, false);
    }
  });
}
async function logout() {
  try { await api('/auth/logout', { method: 'POST' }); } catch { /* 本地也会清理登录界面 */ }
  closeModal();
  showAuth();
}

function bindEvents() {
  $$('.segment').forEach((button) => button.addEventListener('click', () => setAuthMode(button.dataset.authMode)));
  $('#auth-form').addEventListener('submit', submitAuth);
  $('#demo-fill').addEventListener('click', () => {
    $('#auth-username').value = 'demo';
    $('#auth-password').value = 'Demo123!';
    $('#auth-submit').focus();
  });
  $$('.nav-item').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view)));
  $$('[data-go-view]').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.goView)));
  $('#logout-button').addEventListener('click', logout);
  $('#user-menu-button').addEventListener('click', openUserMenu);
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', (event) => { if (event.target === $('#modal')) closeModal(); });
  $('#conversation-search').addEventListener('input', renderConversations);
  $('#conversation-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-conversation-id]');
    if (button) openConversation(button.dataset.conversationId);
  });
  $('#new-group-button').addEventListener('click', openGroupModal);
  $('#contacts-new-group').addEventListener('click', openGroupModal);
  $('#message-form').addEventListener('submit', sendTextMessage);
  $('#message-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      $('#message-form').requestSubmit();
    }
  });
  $('#message-input').addEventListener('input', (event) => {
    event.target.style.height = 'auto';
    event.target.style.height = `${Math.min(event.target.scrollHeight, 120)}px`;
    emitTyping();
  });
  $('#chat-attach-button').addEventListener('click', () => $('#chat-file-input').click());
  $('#chat-file-input').addEventListener('change', (event) => sendChatFile(event.target.files[0]));
  $('#chat-header').addEventListener('click', (event) => {
    if (event.target.closest('[data-chat-back]')) $('#view-chat').classList.remove('chat-detail');
    if (event.target.closest('[data-chat-info]')) openConversationInfo();
  });
  $('#message-list').addEventListener('click', (event) => {
    if (event.target.closest('#load-older')) loadOlderMessages();
    const recallButton = event.target.closest('[data-recall-message]');
    if (recallButton) recallMessage(Number(recallButton.dataset.recallMessage));
  });
  $('#add-friend-form').addEventListener('submit', (event) => { event.preventDefault(); sendFriendRequest($('#friend-search').value); });
  let searchTimer;
  $('#friend-search').addEventListener('input', (event) => {
    clearTimeout(searchTimer);
    const query = event.target.value.trim();
    if (!query) { state.searchUsers = []; renderUserSearchResults(); return; }
    const sequence = ++state.searchSequence;
    searchTimer = setTimeout(async () => {
      try {
        const data = await api(`/users/search?q=${encodeURIComponent(query)}`);
        if (sequence === state.searchSequence) { state.searchUsers = data.users; renderUserSearchResults(); }
      } catch { /* 精确提交时仍会显示错误 */ }
    }, 300);
  });
  $('#view-contacts').addEventListener('click', (event) => {
    const add = event.target.closest('[data-add-username]');
    const message = event.target.closest('[data-message-friend]');
    const accept = event.target.closest('[data-accept-request]');
    const decline = event.target.closest('[data-decline-request]');
    if (add) sendFriendRequest(add.dataset.addUsername);
    if (message) startPrivateChat(message.dataset.messageFriend);
    if (accept) handleFriendAction(accept.dataset.acceptRequest, 'accept');
    if (decline) handleFriendAction(decline.dataset.declineRequest, 'decline');
  });
  $('#file-upload-button').addEventListener('click', () => $('#personal-file-input').click());
  $('#personal-file-input').addEventListener('change', (event) => uploadPersonalFiles(event.target.files).catch((error) => showToast(error.message, 'error')));
  $('#file-drop-zone').addEventListener('click', () => $('#personal-file-input').click());
  $('#file-drop-zone').addEventListener('keydown', (event) => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); $('#personal-file-input').click(); } });
  ['dragenter', 'dragover'].forEach((name) => $('#file-drop-zone').addEventListener(name, (event) => { event.preventDefault(); $('#file-drop-zone').classList.add('dragging'); }));
  ['dragleave', 'drop'].forEach((name) => $('#file-drop-zone').addEventListener(name, (event) => { event.preventDefault(); $('#file-drop-zone').classList.remove('dragging'); }));
  $('#file-drop-zone').addEventListener('drop', (event) => uploadPersonalFiles(event.dataTransfer.files).catch((error) => showToast(error.message, 'error')));
  $('#files-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-delete-file]');
    if (!button) return;
    const file = state.fileData.files.find((item) => item.id === Number(button.dataset.deleteFile));
    openConfirm('删除文件', `确定删除「${file?.original_name || '这个文件'}」吗？此操作无法撤销。`, async () => {
      await api(`/files/${button.dataset.deleteFile}`, { method: 'DELETE' });
      await loadFiles();
      showToast('文件已删除');
    });
  });
  $('#file-search').addEventListener('input', renderFiles);
  $$('[data-file-filter]').forEach((chip) => chip.addEventListener('click', () => {
    $$('[data-file-filter]').forEach((item) => item.classList.remove('active'));
    chip.classList.add('active');
    state.fileFilter = chip.dataset.fileFilter;
    renderFiles();
  }));
  const handleCloudClick = (event) => {
    const favorite = event.target.closest('[data-favorite-game]');
    if (favorite) {
      toggleCloudFavorite(favorite.dataset.favoriteGame);
      renderGames();
      showToast(state.cloudFavorites.has(favorite.dataset.favoriteGame) ? '已加入收藏' : '已取消收藏');
      return;
    }
    const launch = event.target.closest('[data-launch-game]');
    if (launch) { launchGame(launch.dataset.launchGame); return; }
    const open = event.target.closest('[data-open-game]');
    if (open) openGameDetail(open.dataset.openGame);
  };
  ['#games-list', '#cloud-hero', '#cloud-recent'].forEach((selector) => $(selector).addEventListener('click', handleCloudClick));
  $('#cloud-filters').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-cloud-category]');
    if (!chip) return;
    state.cloudCategory = chip.dataset.cloudCategory;
    renderGames();
  });
  $('#cloud-search').addEventListener('input', (event) => {
    state.cloudQuery = event.target.value;
    renderGames();
  });
  $('#cloud-recent-clear').addEventListener('click', () => {
    state.cloudRecent = [];
    writeStoredList(CLOUD_RECENT_KEY, []);
    renderCloudRecent();
    showToast('已清空最近浏览');
  });
  $('#cloud-info-button').addEventListener('click', () => openCloudInfo());

  // 朋友圈：发布、筛选、互动与图片查看
  $('#moments-notice-button').addEventListener('click', openMomentNotifications);
  $('#moments-compose-button').addEventListener('click', () => {
    $('#moment-composer').scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('#moment-text').focus();
  });
  $('#moment-text').addEventListener('input', (event) => {
    $('#moment-count').textContent = `${event.target.value.length} / 2000`;
  });
  $('#moment-add-image').addEventListener('click', () => $('#moment-image-input').click());
  $('#moment-image-input').addEventListener('change', (event) => {
    addMomentImages(event.target.files);
    event.target.value = '';
  });
  $('#moment-image-preview').addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove-draft]');
    if (!remove) return;
    const [item] = state.momentDraft.splice(Number(remove.dataset.removeDraft), 1);
    if (item) URL.revokeObjectURL(item.url);
    renderMomentPreview();
  });
  $('#moment-publish').addEventListener('click', publishMoment);
  $('#moment-filters').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-moment-filter]');
    if (!chip) return;
    state.momentFilter = chip.dataset.momentFilter;
    renderMoments();
  });
  $('#moments-more').addEventListener('click', () => {
    const oldest = state.moments.at(-1);
    if (oldest) loadMoments({ before: oldest.id, append: true });
  });
  $('#moments-list').addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    const data = button.dataset;
    if (data.viewImage) return openImageViewer(data.viewImage);
    if (data.likeMoment) return toggleMomentLike(Number(data.likeMoment));
    if (data.commentMoment) {
      const id = Number(data.commentMoment);
      if (state.momentCommentOpen.has(id)) {
        state.momentCommentOpen.delete(id);
        delete state.momentReplies[id];
      } else state.momentCommentOpen.add(id);
      renderMoments();
      focusMomentComment(id);
      return;
    }
    if (data.replyComment) {
      const id = Number(data.replyMoment);
      state.momentReplies[id] = { id: Number(data.replyUser), name: data.replyName };
      state.momentCommentOpen.add(id);
      renderMoments();
      focusMomentComment(id);
      return;
    }
    if (data.cancelReply) {
      delete state.momentReplies[Number(data.cancelReply)];
      renderMoments();
      return;
    }
    if (data.deleteComment) {
      const momentId = Number(data.commentOf);
      openConfirm('删除评论', '确定删除这条评论吗？此操作无法撤销。', async () => {
        await api(`/moments/${momentId}/comments/${data.deleteComment}`, { method: 'DELETE' });
        await loadMoments();
        showToast('评论已删除');
      });
      return;
    }
    if (data.deleteMomentBtn) {
      const momentId = Number(data.deleteMomentBtn);
      openConfirm('删除动态', '动态、图片、点赞和评论都会一并删除，无法撤销。', async () => {
        await api(`/moments/${momentId}`, { method: 'DELETE' });
        state.momentCommentOpen.delete(momentId);
        delete state.momentReplies[momentId];
        await loadMoments();
        showToast('动态已删除');
      });
    }
  });
  $('#moments-list').addEventListener('submit', async (event) => {
    const form = event.target.closest('[data-comment-form]');
    if (!form) return;
    event.preventDefault();
    const momentId = Number(form.dataset.commentForm);
    const input = $('input', form);
    const body = input.value.trim();
    if (!body) return;
    const reply = state.momentReplies[momentId];
    const submit = $('button[type="submit"]', form);
    setBusy(submit, true, '发送中…');
    try {
      await api(`/moments/${momentId}/comments`, {
        method: 'POST', body: { body, replyToUserId: reply?.id || null }
      });
      delete state.momentReplies[momentId];
      state.momentCommentOpen.add(momentId);
      await loadMoments();
      markMomentsSeen();
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      setBusy(submit, false);
    }
  });
  $('#image-viewer').addEventListener('click', (event) => {
    if (event.target.id === 'image-viewer' || event.target.closest('#image-viewer-close')) closeImageViewer();
  });
  $('#cloud-launch').addEventListener('click', (event) => {
    if (event.target.closest('[data-launch-close]')) closeLaunchOverlay();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('#cloud-launch').hidden) closeLaunchOverlay();
    if (event.key === 'Escape' && !$('#image-viewer').hidden) closeImageViewer();
  });
}

async function init() {
  bindEvents();
  try {
    const status = await api('/auth/status');
    if (status.user) await loadBootstrap();
    else showAuth();
  } catch { showAuth(); }
}

init();
