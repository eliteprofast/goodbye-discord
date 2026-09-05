const messageArea = document.querySelector('#message-area');
const messageForm = document.querySelector('#message-form');
const messageInput = document.querySelector('#message-input');
const profileName = document.querySelector('#profile-name');
const profileAvatar = document.querySelector('#profile-avatar');
const onlineCount = document.querySelector('#online-count');
const nameButton = document.querySelector('#change-name');
const authScreen = document.querySelector('#auth-screen');
const chatTitle = document.querySelector('#chat-title');
const chatSubtitle = document.querySelector('#chat-subtitle');
const authForm = document.querySelector('#auth-form');
const authSubmit = document.querySelector('#auth-submit');
const authSwitch = document.querySelector('#auth-switch');
const authError = document.querySelector('#auth-error');
const rememberMe = document.querySelector('#remember-me');
const emptyChat = document.querySelector('#empty-chat');
const friendSearchForm = document.querySelector('#friend-search-form');
const friendSearchInput = document.querySelector('#friend-search-input');
const friendResults = document.querySelector('#friend-results');
const incomingRequests = document.querySelector('#incoming-requests');
const friendList = document.querySelector('#friend-list');
const logoutButton = document.querySelector('#logout-button');
const clearChatButton = document.querySelector('#clear-chat');
const adminPanelButton = document.querySelector('#admin-panel-button');
const adminPanel = document.querySelector('#admin-panel');
const closeAdminPanel = document.querySelector('#close-admin-panel');
const adminUserList = document.querySelector('#admin-user-list');

const colors = { coral: '#f7ad99', yellow: '#f5c45c', blue: '#acd2e2', mint: '#a8d7c3' };
let socket;
const pendingMessages = [];
let authMode = 'signup';
let currentUser;
let activeFriend;

function send(payload) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  else pendingMessages.push(payload);
}

function escapeHtml(value) {
  return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

function avatar(user) {
  return `<span class="mini-avatar" style="background:${colors[user.color] || colors.yellow}">${user.username.charAt(0).toUpperCase()}</span>`;
}

function renderUserAction(user, relationship) {
  const action = relationship === 'pending' ? 'Pending' : relationship === 'accepted' ? 'Friends' : 'Add friend';
  const disabled = relationship !== 'none' ? ' disabled' : '';
  return `<div class="person-row">${avatar(user)}<strong>${escapeHtml(user.username)}</strong><button class="small-action" data-add="${user.id}"${disabled}>${action}</button></div>`;
}

function renderFriends(payload) {
  friendList.innerHTML = payload.friends.length
    ? payload.friends.map((friend) => `<button class="friend-row${activeFriend?.id === friend.id ? ' selected' : ''}" data-open="${friend.id}">${avatar(friend)}<span>${escapeHtml(friend.username)}</span><i></i></button>`).join('')
    : '<p class="muted-copy">No friends yet.</p>';
  incomingRequests.innerHTML = payload.incoming.length
    ? payload.incoming.map((user) => `<div class="person-row">${avatar(user)}<strong>${escapeHtml(user.username)}</strong><button class="small-action accept" data-accept="${user.id}">Accept</button></div>`).join('')
    : '<p class="muted-copy">No new requests.</p>';
  friendList.querySelectorAll('[data-open]').forEach((button) => button.addEventListener('click', () => {
    activeFriend = payload.friends.find((friend) => friend.id === button.dataset.open);
    send({ type: 'open-chat', userId: activeFriend.id });
  }));
}

function renderSearchResults(results) {
  friendResults.innerHTML = results.length
    ? results.map((user) => renderUserAction(user, user.relationship)).join('')
    : '<p class="muted-copy">No users found.</p>';
  friendResults.querySelectorAll('[data-add]').forEach((button) => button.addEventListener('click', () => {
    send({ type: 'friend-request', userId: button.dataset.add });
    button.textContent = 'Pending';
    button.disabled = true;
  }));
}

function renderMessages(messages) {
  messageArea.innerHTML = '<div class="day-divider"><span>today</span></div>';
  emptyChat.hidden = true;
  messages.forEach(addMessage);
  messageArea.scrollTop = messageArea.scrollHeight;
}

function clearMessages() {
  messageArea.innerHTML = '<div class="day-divider"><span>today</span></div>';
  emptyChat.hidden = false;
  messageArea.appendChild(emptyChat);
}

function addMessage(message) {
  const sender = message.from === currentUser.id ? currentUser : activeFriend;
  const isMine = message.from === currentUser.id;
  const wrapper = document.createElement('article');
  wrapper.className = `message${isMine ? ' mine' : ''}`;
  wrapper.innerHTML = `<div class="message-avatar" style="background:${colors[sender?.color] || colors.yellow}">${(sender?.username || '?').charAt(0).toUpperCase()}</div><div class="message-body"><div class="message-meta"><strong>${escapeHtml(sender?.username || 'Friend')}</strong><time>${new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' }).format(new Date(message.time))}</time></div><div class="bubble">${escapeHtml(message.text)}</div></div>`;
  messageArea.appendChild(wrapper);
}

function showAuthError(message) {
  authError.textContent = message;
}

function renderAdminData(users) {
  adminUserList.innerHTML = users.map((user) => `<div class="admin-user-row"><span class="mini-avatar">${user.username.charAt(0).toUpperCase()}</span><strong>${escapeHtml(user.username)}</strong><span class="admin-role">${user.role}</span></div>`).join('');
}

function connect() {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${protocol}://${window.location.host}`);
  socket.addEventListener('open', () => {
    while (pendingMessages.length) socket.send(JSON.stringify(pendingMessages.shift()));
  });
  socket.addEventListener('message', (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === 'session') {
      const savedToken = localStorage.getItem('gather-session');
      if (savedToken) send({ type: 'resume', token: savedToken });
    }
    if (payload.type === 'resume-failed') {
      localStorage.removeItem('gather-session');
      sessionStorage.removeItem('gather-user');
      currentUser = undefined;
      authScreen.hidden = false;
    }
    if (payload.type === 'authenticated') {
      currentUser = payload.user;
      sessionStorage.setItem('gather-user', JSON.stringify(currentUser));
      if (payload.token) localStorage.setItem('gather-session', payload.token);
      else localStorage.removeItem('gather-session');
      profileName.textContent = currentUser.username;
      profileAvatar.textContent = currentUser.username.charAt(0).toUpperCase();
      authScreen.hidden = true;
      adminPanelButton.hidden = !['owner', 'admin'].includes(currentUser.role);
    }
    if (payload.type === 'friends') {
      renderFriends(payload);
      incomingRequests.querySelectorAll('[data-accept]').forEach((button) => button.addEventListener('click', () => {
        const request = payload.incoming.find((user) => user.id === button.dataset.accept);
        const item = payload.incoming.find((user) => user.id === button.dataset.accept);
        if (item) send({ type: 'friend-response', requestId: findRequestId(item.id, payload) , accept: true });
      }));
    }
    if (payload.type === 'user-results') renderSearchResults(payload.results);
    if (payload.type === 'chat-history') {
      activeFriend = payload.user;
      chatTitle.textContent = activeFriend.username;
      chatSubtitle.textContent = 'Private conversation';
      messageInput.disabled = false;
      messageInput.placeholder = `Message ${activeFriend.username}...`;
      renderMessages(payload.messages);
    }
    if (payload.type === 'message' && activeFriend && (payload.message.from === activeFriend.id || payload.message.to === activeFriend.id)) addMessage(payload.message);
    if (payload.type === 'chat-cleared' && activeFriend?.id === payload.userId) clearMessages();
    if (payload.type === 'error') showAuthError(payload.message);
    if (payload.type === 'admin-data') renderAdminData(payload.users);
    if (payload.type === 'admin-denied') adminPanel.hidden = true;
  });
  socket.addEventListener('close', () => setTimeout(connect, 1500));
}

function findRequestId(userId, payload) {
  return payload.incoming.find((user) => user.id === userId)?.requestId || userId;
}

authForm.addEventListener('submit', (event) => {
  event.preventDefault();
  authError.textContent = '';
  const username = document.querySelector('#auth-username').value.trim();
  const password = document.querySelector('#auth-password').value;
  send({ type: authMode, username, password, remember: rememberMe.checked });
});

authSwitch.addEventListener('click', () => {
  authMode = authMode === 'signup' ? 'login' : 'signup';
  authSubmit.textContent = authMode === 'signup' ? 'Create account' : 'Log in';
  authSwitch.textContent = authMode === 'signup' ? 'Already have an account? Log in' : 'New here? Create an account';
});

friendSearchForm.addEventListener('submit', (event) => {
  event.preventDefault();
  send({ type: 'search-users', query: friendSearchInput.value });
});

messageForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = messageInput.value.trim();
  if (!text || !activeFriend) return;
  send({ type: 'message', to: activeFriend.id, text });
  messageInput.value = '';
});

logoutButton.addEventListener('click', () => {
  sessionStorage.clear();
  localStorage.removeItem('gather-session');
  window.location.reload();
});

clearChatButton.addEventListener('click', () => {
  if (!activeFriend || !window.confirm(`Clear your chat with ${activeFriend.username}? This removes it for both of you.`)) return;
  send({ type: 'clear-chat', userId: activeFriend.id });
});

adminPanelButton.addEventListener('click', () => {
  adminPanel.hidden = false;
  send({ type: 'admin-panel' });
});

closeAdminPanel.addEventListener('click', () => {
  adminPanel.hidden = true;
});

const savedUser = sessionStorage.getItem('gather-user');
if (savedUser) currentUser = JSON.parse(savedUser);
else authScreen.hidden = false;
connect();

