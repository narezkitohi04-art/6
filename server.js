const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// In-memory database
const db = {
  users: {},
  chats: {},
  onlineUsers: {},
  channels: {},        // Каналы/подписки
  channelMessages: {}  // Сообщения в каналах
};

// ========================
// REST API ENDPOINTS
// ========================

// Регистрация
app.post('/api/auth/register', (req, res) => {
  const { username, password, avatar, description } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  if (db.users[username]) {
    return res.status(400).json({ error: 'Username already taken' });
  }

  db.users[username] = {
    password,
    avatar: avatar || '',
    description: description || '',
    friends: [],
    createdAt: new Date().toISOString()
  };

  res.json({ success: true, message: 'User registered successfully' });
});

// Вход
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const user = db.users[username];
  if (!user || user.password !== password) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  res.json({
    success: true,
    token: Buffer.from(username).toString('base64'),
    user: {
      username,
      avatar: user.avatar,
      description: user.description,
      friends: user.friends
    }
  });
});

// Получить профиль пользователя
app.get('/api/user/:username', (req, res) => {
  const { username } = req.params;
  const user = db.users[username];

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.json({
    username,
    avatar: user.avatar,
    description: user.description,
    friends: user.friends,
    online: !!db.onlineUsers[username]
  });
});

// Добавить друга
app.post('/api/friends/add', (req, res) => {
  const { currentUser, friendUsername } = req.body;

  if (!db.users[currentUser] || !db.users[friendUsername]) {
    return res.status(404).json({ error: 'User not found' });
  }

  if (currentUser === friendUsername) {
    return res.status(400).json({ error: 'Cannot add yourself' });
  }

  if (db.users[currentUser].friends.includes(friendUsername)) {
    return res.status(400).json({ error: 'Already friends' });
  }

  db.users[currentUser].friends.push(friendUsername);
  db.users[friendUsername].friends.push(currentUser);

  res.json({ success: true, message: 'Friend added' });
});

// Получить друзей
app.get('/api/friends/:username', (req, res) => {
  const { username } = req.params;
  const user = db.users[username];

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const friends = user.friends.map(friendName => ({
    username: friendName,
    avatar: db.users[friendName].avatar,
    description: db.users[friendName].description,
    online: !!db.onlineUsers[friendName]
  }));

  res.json({ friends });
});

// Получить сообщения между двумя пользователями
app.get('/api/messages/:user1/:user2', (req, res) => {
  const { user1, user2 } = req.params;
  const chatId = [user1, user2].sort().join('_');
  const messages = db.chats[chatId] || [];

  res.json({ messages });
});

// Отправить сообщение
app.post('/api/messages/send', (req, res) => {
  const { sender, recipient, type, content } = req.body;

  if (!db.users[sender] || !db.users[recipient]) {
    return res.status(404).json({ error: 'User not found' });
  }

  const chatId = [sender, recipient].sort().join('_');
  if (!db.chats[chatId]) {
    db.chats[chatId] = [];
  }

  const message = {
    sender,
    type,
    content,
    timestamp: new Date().toISOString()
  };

  db.chats[chatId].push(message);

  // Отправить через Socket.IO если пользователь онлайн
  const recipientSocket = db.onlineUsers[recipient];
  if (recipientSocket) {
    io.to(recipientSocket).emit('new-message', message);
  }

  res.json({ success: true, message });
});

// ========================
// КАНАЛЫ И ПОДПИСКИ
// ========================

// Создать канал
app.post('/api/channels/create', (req, res) => {
  const { owner, channelName, description } = req.body;

  if (!owner || !channelName) {
    return res.status(400).json({ error: 'Owner and channel name required' });
  }

  if (!db.users[owner]) {
    return res.status(404).json({ error: 'User not found' });
  }

  const channelId = channelName.toLowerCase().replace(/\s+/g, '-');
  
  if (db.channels[channelId]) {
    return res.status(400).json({ error: 'Channel already exists' });
  }

  db.channels[channelId] = {
    id: channelId,
    name: channelName,
    owner: owner,
    description: description || '',
    subscribers: [owner],
    createdAt: new Date().toISOString()
  };

  db.channelMessages[channelId] = [];

  res.json({ success: true, channelId, channel: db.channels[channelId] });
});

// Получить все каналы
app.get('/api/channels', (req, res) => {
  const channels = Object.values(db.channels).map(ch => ({
    ...ch,
    subscriberCount: ch.subscribers.length
  }));

  res.json({ channels });
});

// Подписаться на канал
app.post('/api/channels/subscribe', (req, res) => {
  const { username, channelId } = req.body;

  if (!db.users[username] || !db.channels[channelId]) {
    return res.status(404).json({ error: 'User or channel not found' });
  }

  const channel = db.channels[channelId];
  if (channel.subscribers.includes(username)) {
    return res.status(400).json({ error: 'Already subscribed' });
  }

  channel.subscribers.push(username);
  res.json({ success: true, message: 'Subscribed' });
});

// Отписаться от канала
app.post('/api/channels/unsubscribe', (req, res) => {
  const { username, channelId } = req.body;

  if (!db.channels[channelId]) {
    return res.status(404).json({ error: 'Channel not found' });
  }

  const channel = db.channels[channelId];
  const index = channel.subscribers.indexOf(username);
  
  if (index === -1) {
    return res.status(400).json({ error: 'Not subscribed' });
  }

  channel.subscribers.splice(index, 1);
  res.json({ success: true, message: 'Unsubscribed' });
});

// Отправить сообщение в канал
app.post('/api/channels/message', (req, res) => {
  const { sender, channelId, content } = req.body;

  if (!db.users[sender] || !db.channels[channelId]) {
    return res.status(404).json({ error: 'User or channel not found' });
  }

  const message = {
    sender,
    content,
    timestamp: new Date().toISOString()
  };

  db.channelMessages[channelId].push(message);

  // Отправить в реал-тайм подписчикам
  io.emit('channel-message', { channelId, message });

  res.json({ success: true, message });
});

// Получить сообщения канала
app.get('/api/channels/:channelId/messages', (req, res) => {
  const { channelId } = req.params;

  if (!db.channels[channelId]) {
    return res.status(404).json({ error: 'Channel not found' });
  }

  const messages = db.channelMessages[channelId] || [];
  res.json({ messages });
});

// Получить подписки пользователя
app.get('/api/channels/user/:username', (req, res) => {
  const { username } = req.params;

  if (!db.users[username]) {
    return res.status(404).json({ error: 'User not found' });
  }

  const subscriptions = Object.values(db.channels)
    .filter(ch => ch.subscribers.includes(username))
    .map(ch => ({
      ...ch,
      subscriberCount: ch.subscribers.length
    }));

  res.json({ subscriptions });
});

// ========================
// WEBSOCKET (Socket.IO)
// ========================

io.on('connection', (socket) => {
  console.log('New connection:', socket.id);

  socket.on('user-online', (username) => {
    db.onlineUsers[username] = socket.id;
    socket.username = username;
    io.emit('user-status-changed', { username, online: true });
  });

  socket.on('send-message', (data) => {
    const { sender, recipient, type, content } = data;
    const chatId = [sender, recipient].sort().join('_');

    if (!db.chats[chatId]) {
      db.chats[chatId] = [];
    }

    const message = {
      sender,
      type,
      content,
      timestamp: new Date().toISOString()
    };

    db.chats[chatId].push(message);

    const recipientSocket = db.onlineUsers[recipient];
    if (recipientSocket) {
      io.to(recipientSocket).emit('new-message', message);
    }
  });

  socket.on('call-initiated', (data) => {
    const { caller, callee, type } = data;
    const calleeSocket = db.onlineUsers[callee];

    if (calleeSocket) {
      io.to(calleeSocket).emit('incoming-call', {
        caller,
        type,
        offer: data.offer
      });
    }
  });

  socket.on('call-answer', (data) => {
    const { caller, callee, answer } = data;
    const callerSocket = db.onlineUsers[caller];

    if (callerSocket) {
      io.to(callerSocket).emit('call-answered', {
        callee,
        answer
      });
    }
  });

  socket.on('ice-candidate', (data) => {
    const { to, candidate } = data;
    const targetSocket = db.onlineUsers[to];

    if (targetSocket) {
      io.to(targetSocket).emit('ice-candidate', {
        from: socket.username,
        candidate
      });
    }
  });

  socket.on('disconnect', () => {
    if (socket.username) {
      delete db.onlineUsers[socket.username];
      io.emit('user-status-changed', { username: socket.username, online: false });
    }
  });
});

// ========================
// STATIC FILES
// ========================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ========================
// START SERVER
// ========================

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
  console.log(`Server is running on http://0.0.0.0:${PORT}`);
  console.log(`Public URL will be shown by your hosting provider`);
});
