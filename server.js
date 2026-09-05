const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const port = process.env.PORT || 3000;
const publicDir = path.join(__dirname, 'public');
const dataPath = path.join(__dirname, 'data.json');
const clients = new Map();
const colors = ['coral', 'yellow', 'blue', 'mint'];

function loadData() {
  if (!fs.existsSync(dataPath)) return { users: [], friendships: [], messages: [] };
  return JSON.parse(fs.readFileSync(dataPath, 'utf8'));
}

const data = loadData();

if (data.users.length && !data.users.some((user) => user.role === 'owner')) {
  data.users[0].role = 'owner';
  saveData();
}

function saveData() {
  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
}

function makeId() {
  return crypto.randomUUID();
}

function createSession(user) {
  const signature = crypto.createHmac('sha256', user.password).update(user.id).digest('hex');
  return `${user.id}.${signature}`;
}

function userFromSession(token) {
  const [userId, signature] = String(token || '').split('.');
  const user = data.users.find((candidate) => candidate.id === userId);
  if (!user || !signature) return null;
  const expected = crypto.createHmac('sha256', user.password).update(user.id).digest('hex');
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  return user;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(`${salt}:${derivedKey.toString('hex')}`);
    });
  });
}

async function verifyPassword(password, storedHash) {
  const [salt, key] = storedHash.split(':');
  const candidate = await hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(candidate.split(':')[1], 'hex'), Buffer.from(key, 'hex'));
}

function publicUser(user) {
  return { id: user.id, username: user.username, color: user.color, role: user.role || 'member' };
}

function isStaff(user) {
  return user && (user.role === 'owner' || user.role === 'admin');
}

function friendshipBetween(firstId, secondId) {
  return data.friendships.find((item) =>
    (item.from === firstId && item.to === secondId) || (item.from === secondId && item.to === firstId)
  );
}

function friendsFor(userId) {
  return data.friendships
    .filter((item) => item.status === 'accepted' && (item.from === userId || item.to === userId))
    .map((item) => data.users.find((user) => user.id === (item.from === userId ? item.to : item.from)))
    .filter(Boolean)
    .map(publicUser);
}

function send(socket, payload) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
}

function sendFriends(socket, userId) {
  const incoming = data.friendships
    .filter((item) => item.to === userId && item.status === 'pending')
    .map((item) => ({ user: data.users.find((user) => user.id === item.from), requestId: item.id }))
    .filter(Boolean)
    .filter((item) => item.user)
    .map((item) => ({ ...publicUser(item.user), requestId: item.requestId }));
  const outgoing = data.friendships
    .filter((item) => item.from === userId && item.status === 'pending')
    .map((item) => data.users.find((user) => user.id === item.to))
    .filter(Boolean)
    .map(publicUser);
  send(socket, { type: 'friends', friends: friendsFor(userId), incoming, outgoing });
}

function directMessages(firstId, secondId) {
  return data.messages.filter((message) =>
    (message.from === firstId && message.to === secondId) || (message.from === secondId && message.to === firstId)
  );
}

const server = http.createServer((request, response) => {
  const requestedPath = request.url === '/' ? '/index.html' : request.url;
  const filePath = path.normalize(path.join(publicDir, requestedPath));

  if (!filePath.startsWith(publicDir)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (error, file) => {
    if (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500);
      response.end(error.code === 'ENOENT' ? 'Not found' : 'Server error');
      return;
    }

    const extension = path.extname(filePath);
    const contentTypes = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.svg': 'image/svg+xml'
    };
    response.writeHead(200, { 'Content-Type': contentTypes[extension] || 'application/octet-stream' });
    response.end(file);
  });
});

const webSocketServer = new WebSocketServer({ server });

webSocketServer.on('connection', (socket) => {
  send(socket, { type: 'session' });

  socket.on('message', async (rawMessage) => {
    let payload;
    try {
      payload = JSON.parse(rawMessage.toString());
    } catch {
      return;
    }

    if (payload.type === 'resume') {
      const user = userFromSession(payload.token);
      if (!user) {
        send(socket, { type: 'resume-failed' });
        return;
      }
      clients.set(socket, user.id);
      send(socket, { type: 'authenticated', user: publicUser(user) });
      sendFriends(socket, user.id);
      return;
    }

    if (payload.type === 'signup' || payload.type === 'login') {
      const username = String(payload.username || '').trim().toLowerCase();
      const password = String(payload.password || '');
      if (!/^[a-z0-9_]{3,20}$/.test(username) || password.length < 6) {
        send(socket, { type: 'error', message: 'Use a username with 3-20 letters, numbers, or underscores and a 6+ character password.' });
        return;
      }
      const existingUser = data.users.find((user) => user.username === username);
      if (payload.type === 'signup' && existingUser) {
        send(socket, { type: 'error', message: 'That username is already taken.' });
        return;
      }
      if (payload.type === 'login' && (!existingUser || !(await verifyPassword(password, existingUser.password)))) {
        send(socket, { type: 'error', message: 'Username or password is incorrect.' });
        return;
      }
      const user = existingUser || { id: makeId(), username, password: await hashPassword(password), color: colors[data.users.length % colors.length], role: data.users.length ? 'member' : 'owner' };
      if (!existingUser) {
        data.users.push(user);
        saveData();
      }
      clients.set(socket, user.id);
      send(socket, { type: 'authenticated', user: publicUser(user), token: payload.remember ? createSession(user) : null });
      sendFriends(socket, user.id);
      return;
    }

    const userId = clients.get(socket);
    if (!userId) {
      send(socket, { type: 'error', message: 'Please log in first.' });
      return;
    }

    if (payload.type === 'admin-panel') {
      const user = data.users.find((candidate) => candidate.id === userId);
      if (!isStaff(user)) {
        send(socket, { type: 'admin-denied' });
        return;
      }
      send(socket, {
        type: 'admin-data',
        users: data.users.map((candidate) => ({ id: candidate.id, username: candidate.username, role: candidate.role || 'member' }))
      });
      return;
    }

    if (payload.type === 'update-role') {
      const actor = data.users.find((candidate) => candidate.id === userId);
      const target = data.users.find((candidate) => candidate.id === payload.userId);
      const nextRole = payload.role === 'admin' ? 'admin' : 'member';
      if (!actor || actor.role !== 'owner' || !target || target.role === 'owner' || target.id === actor.id) {
        send(socket, { type: 'role-denied' });
        return;
      }
      target.role = nextRole;
      saveData();
      send(socket, { type: 'role-updated' });
      send(socket, {
        type: 'admin-data',
        users: data.users.map((candidate) => ({ id: candidate.id, username: candidate.username, role: candidate.role || 'member' }))
      });
      for (const [otherSocket, otherUserId] of clients) {
        if (otherUserId === target.id) send(otherSocket, { type: 'authenticated', user: publicUser(target) });
      }
      return;
    }

    if (payload.type === 'search-users') {
      const query = String(payload.query || '').trim().toLowerCase();
      const results = data.users
        .filter((user) => user.id !== userId && user.username.includes(query))
        .slice(0, 8)
        .map((user) => ({ ...publicUser(user), relationship: friendshipBetween(userId, user.id)?.status || 'none' }));
      send(socket, { type: 'user-results', results });
      return;
    }

    if (payload.type === 'friend-request') {
      const target = data.users.find((user) => user.id === payload.userId);
      if (!target || target.id === userId || friendshipBetween(userId, target.id)) return;
      data.friendships.push({ id: makeId(), from: userId, to: target.id, status: 'pending' });
      saveData();
      sendFriends(socket, userId);
      for (const [otherSocket, otherUserId] of clients) if (otherUserId === target.id) sendFriends(otherSocket, target.id);
      return;
    }

    if (payload.type === 'friend-response') {
      const request = data.friendships.find((item) => item.id === payload.requestId && item.to === userId && item.status === 'pending');
      if (!request) return;
      request.status = payload.accept ? 'accepted' : 'declined';
      saveData();
      sendFriends(socket, userId);
      for (const [otherSocket, otherUserId] of clients) if (otherUserId === request.from) sendFriends(otherSocket, request.from);
      return;
    }

    if (payload.type === 'open-chat') {
      const target = data.users.find((user) => user.id === payload.userId);
      if (!target || !friendshipBetween(userId, target.id) || friendshipBetween(userId, target.id).status !== 'accepted') return;
      send(socket, { type: 'chat-history', user: publicUser(target), messages: directMessages(userId, target.id) });
      return;
    }

    if (payload.type === 'clear-chat') {
      const target = data.users.find((user) => user.id === payload.userId);
      const friendship = target && friendshipBetween(userId, target.id);
      if (!target || !friendship || friendship.status !== 'accepted') return;
      data.messages = data.messages.filter((message) =>
        !((message.from === userId && message.to === target.id) || (message.from === target.id && message.to === userId))
      );
      saveData();
      for (const [otherSocket, otherUserId] of clients) {
        if (otherUserId === userId || otherUserId === target.id) send(otherSocket, { type: 'chat-cleared', userId: target.id });
      }
      return;
    }

    if (payload.type === 'message') {
      const target = data.users.find((user) => user.id === payload.to);
      if (!target || !friendshipBetween(userId, target.id) || friendshipBetween(userId, target.id).status !== 'accepted') return;
      const text = String(payload.text || '').trim().slice(0, 1000);
      if (!text) return;
      const message = { id: makeId(), from: userId, to: target.id, text, time: new Date().toISOString() };
      data.messages.push(message);
      if (data.messages.length > 1000) data.messages.shift();
      saveData();
      for (const [otherSocket, otherUserId] of clients) {
        if (otherUserId === userId || otherUserId === target.id) send(otherSocket, { type: 'message', message });
      }
    }
  });

  socket.on('close', () => clients.delete(socket));
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Goodbye Discord is running at http://localhost:${port}`);
});
