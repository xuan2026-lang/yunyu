const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { publicUser, createSession, destroySession, requireAuth } = require('./auth');
const { now } = require('./db');
const { listGames, getGame } = require('./cloud');

const MAX_FILE_SIZE = 25 * 1024 * 1024;
const MAX_STORAGE = 200 * 1024 * 1024;
const MAX_MOMENT_IMAGE_SIZE = 5 * 1024 * 1024;
const MAX_MOMENT_TOTAL_SIZE = 20 * 1024 * 1024;
const MAX_MOMENT_IMAGES = 9;
const MOMENT_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MOMENT_VISIBILITIES = ['friends', 'private', 'public'];

function createApiRouter({ db, uploadDir, io }) {
  const router = express.Router();
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: '尝试次数较多，请稍后再试' }
  });
  const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: '注册请求较多，请一小时后再试' }
  });
  const uploadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 40,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: '上传过于频繁，请稍后再试' }
  });
  const storage = multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, uploadDir),
    filename: (_req, _file, callback) => callback(null, crypto.randomUUID())
  });
  const upload = multer({ storage, limits: { fileSize: MAX_FILE_SIZE, files: 1 } });
  // 朋友圈图片单独限流：最多 9 张、单张 5 MB，且只写入同一个受控上传目录。
  const momentImageUpload = multer({
    storage,
    limits: { fileSize: MAX_MOMENT_IMAGE_SIZE, files: MAX_MOMENT_IMAGES }
  });
  const dummyHash = bcrypt.hashSync('dummy-password-for-timing', 10);

  const fail = (res, status, message) => res.status(status).json({ error: message });
  const numericId = (value) => {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  };
  const isMember = (conversationId, userId) => Boolean(db.prepare(
    'SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
  ).get(conversationId, userId));
  const isOnline = (userId) => Boolean(io?.sockets.adapter.rooms.get(`user:${userId}`)?.size);
  const emitToUser = (userId, event, payload = {}) => io?.to(`user:${userId}`).emit(event, payload);
  const conversationMemberIds = (conversationId) => db.prepare(
    'SELECT user_id FROM conversation_members WHERE conversation_id = ?'
  ).all(conversationId).map((row) => row.user_id);
  const notifyConversation = (conversationId, event, payload) => {
    for (const userId of conversationMemberIds(conversationId)) emitToUser(userId, event, payload);
  };
  const safeUploadPath = (storedName) => {
    if (path.basename(storedName) !== storedName) throw new Error('非法文件名');
    const resolvedRoot = path.resolve(uploadDir);
    const resolvedPath = path.resolve(resolvedRoot, storedName);
    if (!resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error('非法文件路径');
    return resolvedPath;
  };
  const removeUpload = (storedName) => {
    try { fs.unlinkSync(safeUploadPath(storedName)); } catch (error) {
      if (error.code !== 'ENOENT') console.error('清理上传文件失败:', error.message);
    }
  };

  function serializeMessage(row) {
    if (!row) return null;
    return {
      id: row.id,
      conversation_id: row.conversation_id,
      body: row.body,
      created_at: row.created_at,
      sender: {
        id: row.sender_id,
        username: row.username,
        display_name: row.display_name,
        avatar_color: row.avatar_color
      },
      attachment: row.attachment_id ? {
        id: row.attachment_id,
        original_name: row.original_name,
        size: row.size,
        mime: row.mime,
        download_url: `/api/files/${row.attachment_id}/download`
      } : null
    };
  }

  function getMessage(id) {
    return serializeMessage(db.prepare(`SELECT m.*, u.username, u.display_name, u.avatar_color,
      f.original_name, f.size, f.mime
      FROM messages m JOIN users u ON u.id = m.sender_id
      LEFT JOIN files f ON f.id = m.attachment_id WHERE m.id = ?`).get(id));
  }

  function serializeConversation(row, userId) {
    const conversation = {
      id: row.id,
      type: row.type,
      created_at: row.created_at,
      group_id: row.group_id,
      members: []
    };
    if (row.type === 'private') {
      const peer = db.prepare(`SELECT u.* FROM conversation_members cm
        JOIN users u ON u.id = cm.user_id
        WHERE cm.conversation_id = ? AND cm.user_id <> ?`).get(row.id, userId);
      conversation.name = peer?.display_name || '已注销用户';
      conversation.peer = peer ? { ...publicUser(peer), online: isOnline(peer.id) } : null;
      conversation.peer_last_read_message_id = peer
        ? db.prepare(`SELECT last_read_message_id FROM conversation_members
            WHERE conversation_id = ? AND user_id = ?`).get(row.id, peer.id)?.last_read_message_id || 0
        : 0;
    } else {
      const group = db.prepare('SELECT * FROM chat_groups WHERE id = ?').get(row.group_id);
      conversation.name = group?.name || '群聊';
      conversation.owner_id = group?.owner_id;
      conversation.members = db.prepare(`SELECT u.id, u.username, u.display_name, u.avatar_color, cm.role
        FROM conversation_members cm JOIN users u ON u.id = cm.user_id
        WHERE cm.conversation_id = ? ORDER BY cm.role DESC, u.display_name`).all(row.id)
        .map((member) => ({ ...member, online: isOnline(member.id) }));
    }
    const lastRow = db.prepare(`SELECT m.*, u.username, u.display_name, u.avatar_color,
      f.original_name, f.size, f.mime FROM messages m
      JOIN users u ON u.id = m.sender_id LEFT JOIN files f ON f.id = m.attachment_id
      WHERE m.conversation_id = ? ORDER BY m.id DESC LIMIT 1`).get(row.id);
    conversation.last_message = serializeMessage(lastRow);
    const membership = db.prepare(`SELECT last_read_message_id FROM conversation_members
      WHERE conversation_id = ? AND user_id = ?`).get(row.id, userId);
    conversation.unread = db.prepare(`SELECT COUNT(*) AS count FROM messages
      WHERE conversation_id = ? AND id > ? AND sender_id <> ?`)
      .get(row.id, membership?.last_read_message_id || 0, userId).count;
    return conversation;
  }

  function listConversations(userId) {
    return db.prepare(`SELECT c.* FROM conversations c JOIN conversation_members cm
      ON cm.conversation_id = c.id WHERE cm.user_id = ?`).all(userId)
      .map((row) => serializeConversation(row, userId))
      .sort((a, b) => (b.last_message?.created_at || b.created_at).localeCompare(a.last_message?.created_at || a.created_at));
  }

  function listFriends(userId) {
    return db.prepare(`SELECT u.* FROM friendships f JOIN users u ON u.id = f.friend_id
      WHERE f.user_id = ? ORDER BY u.display_name`).all(userId)
      .map((friend) => ({ ...publicUser(friend), online: isOnline(friend.id) }));
  }

  function listRequests(userId) {
    const incoming = db.prepare(`SELECT r.id, r.created_at, u.id AS sender_id, u.username,
      u.display_name, u.avatar_color FROM friend_requests r JOIN users u ON u.id = r.sender_id
      WHERE r.recipient_id = ? AND r.status = 'pending' ORDER BY r.id DESC`).all(userId);
    const outgoing = db.prepare(`SELECT r.id, r.created_at, u.id AS recipient_id, u.username,
      u.display_name, u.avatar_color FROM friend_requests r JOIN users u ON u.id = r.recipient_id
      WHERE r.sender_id = ? AND r.status = 'pending' ORDER BY r.id DESC`).all(userId);
    return { incoming, outgoing };
  }

  function cleanOriginalName(name) {
    let value = String(name || '未命名文件');
    if (/^[\u0000-\u00ff]+$/.test(value) && /[\u0080-\u00ff]/.test(value)) {
      const decoded = Buffer.from(value, 'latin1').toString('utf8');
      if (!decoded.includes('\uFFFD')) value = decoded;
    }
    const cleaned = path.basename(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
    return (cleaned || '未命名文件').slice(0, 180);
  }

  function checkStorage(userId, incomingSize) {
    const used = db.prepare('SELECT COALESCE(SUM(size), 0) AS total FROM files WHERE owner_id = ?').get(userId).total;
    return { allowed: used + incomingSize <= MAX_STORAGE, used, limit: MAX_STORAGE };
  }

  // 朋友圈：可见范围始终按「当前好友关系」判断，删掉好友后就不再看到对方动态。
  function canViewMoment(row, userId) {
    if (!row) return false;
    if (row.user_id === userId || row.visibility === 'public') return true;
    if (row.visibility === 'private') return false;
    return Boolean(db.prepare('SELECT 1 FROM friendships WHERE user_id = ? AND friend_id = ?')
      .get(userId, row.user_id));
  }

  function getMomentRow(id) {
    return db.prepare('SELECT * FROM moments WHERE id = ?').get(id);
  }

  function momentFriendIds(userId) {
    return db.prepare('SELECT friend_id FROM friendships WHERE user_id = ?')
      .all(userId).map((row) => row.friend_id);
  }

  function notifyMomentChange(momentId, authorId, visibility) {
    const payload = { momentId };
    if (visibility === 'public') return io?.emit('moments:changed', payload);
    const targets = new Set([authorId, ...momentFriendIds(authorId)]);
    for (const userId of targets) emitToUser(userId, 'moments:changed', payload);
  }

  // 别人赞或评论我的动态时，单独提醒动态作者（自己的操作不提醒自己）。
  function notifyMomentActivity(row, actorId, type) {
    if (row.user_id !== actorId) {
      emitToUser(row.user_id, 'moments:activity', { momentId: row.id, type });
    }
  }

  function serializeMoment(row, userId) {
    const author = db.prepare('SELECT id, username, display_name, avatar_color FROM users WHERE id = ?')
      .get(row.user_id) || { id: row.user_id, username: '', display_name: '已注销用户', avatar_color: '#4f7568' };
    const images = db.prepare('SELECT id, mime, size FROM moment_media WHERE moment_id = ? ORDER BY position, id')
      .all(row.id).map((media) => ({
        id: media.id, url: `/api/moments/media/${media.id}`, mime: media.mime, size: media.size
      }));
    const likes = db.prepare(`SELECT u.id, u.display_name FROM moment_likes l
      JOIN users u ON u.id = l.user_id WHERE l.moment_id = ? ORDER BY l.created_at, l.user_id`)
      .all(row.id);
    const comments = db.prepare(`SELECT c.*, u.username, u.display_name, r.display_name AS reply_name
      FROM moment_comments c JOIN users u ON u.id = c.user_id
      LEFT JOIN users r ON r.id = c.reply_to_user_id WHERE c.moment_id = ? ORDER BY c.id`)
      .all(row.id).map((comment) => ({
        id: comment.id,
        body: comment.body,
        created_at: comment.created_at,
        author: { id: comment.user_id, username: comment.username, display_name: comment.display_name },
        reply_to: comment.reply_to_user_id
          ? { id: comment.reply_to_user_id, display_name: comment.reply_name || '已注销用户' }
          : null,
        deletable: comment.user_id === userId || row.user_id === userId
      }));
    return {
      id: row.id,
      body: row.body,
      visibility: row.visibility,
      created_at: row.created_at,
      author,
      images,
      likes,
      liked: likes.some((like) => like.id === userId),
      comments,
      can_delete: row.user_id === userId
    };
  }

  function createPrivateConversation(userId, friendId) {
    const key = [userId, friendId].sort((a, b) => a - b).join(':');
    let row = db.prepare('SELECT * FROM conversations WHERE private_key = ?').get(key);
    if (!row) {
      const create = db.transaction(() => {
        const result = db.prepare('INSERT INTO conversations (type, private_key, created_at) VALUES (?, ?, ?)')
          .run('private', key, now());
        const conversationId = Number(result.lastInsertRowid);
        const addMember = db.prepare('INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)');
        addMember.run(conversationId, userId);
        addMember.run(conversationId, friendId);
        return conversationId;
      });
      const conversationId = create();
      row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
    }
    return row;
  }

  router.get('/health', (_req, res) => res.json({ ok: true, service: '云屿', time: now() }));
  router.get('/auth/status', (req, res) => res.json({ user: publicUser(req.user) }));

  router.post('/auth/register', registerLimiter, (req, res) => {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    if (!/^[\p{L}\p{N}_]{3,20}$/u.test(username)) {
      return fail(res, 400, '用户名需为 3–20 个字符，可含中文、字母、数字和下划线');
    }
    if (password.length < 8 || password.length > 72 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
      return fail(res, 400, '密码需为 8–72 个字符，并同时包含英文字母和数字');
    }
    if (db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(username)) {
      return fail(res, 409, '这个用户名已被使用');
    }
    const colors = ['#4f7568', '#657b9b', '#a46f52', '#8a6f8e', '#56727f'];
    const color = colors[crypto.randomInt(colors.length)];
    const result = db.prepare(`INSERT INTO users
      (username, display_name, password_hash, avatar_color, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(username, username, bcrypt.hashSync(password, 12), color, now());
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
    const expiresAt = createSession(db, user.id, res);
    res.status(201).json({ user: publicUser(user), expiresAt });
  });

  router.post('/auth/login', authLimiter, (req, res) => {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    const user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
    const valid = bcrypt.compareSync(password, user?.password_hash || dummyHash);
    if (!user || !valid) return fail(res, 401, '用户名或密码不正确');
    const expiresAt = createSession(db, user.id, res);
    res.json({ user: publicUser(user), expiresAt });
  });

  router.post('/auth/logout', (req, res) => {
    destroySession(db, req, res);
    res.json({ ok: true });
  });

  router.use(requireAuth);

  router.get('/me', (req, res) => {
    const session = db.prepare('SELECT expires_at FROM sessions WHERE user_id = ? ORDER BY expires_at DESC LIMIT 1').get(req.user.id);
    res.json({ user: publicUser(req.user), expiresAt: session?.expires_at });
  });

  const AVATAR_COLORS = ['#4f7568', '#657b9b', '#a46f52', '#8a6f8e', '#56727f'];

  router.patch('/me', (req, res) => {
    const displayName = String(req.body?.display_name ?? '').trim();
    const avatarColor = String(req.body?.avatar_color ?? '').trim().toLowerCase();
    if (displayName.length < 2 || displayName.length > 30) {
      return fail(res, 400, '昵称需为 2–30 个字符');
    }
    if (!AVATAR_COLORS.includes(avatarColor)) {
      return fail(res, 400, '请从预设颜色中选择头像颜色');
    }
    db.prepare('UPDATE users SET display_name = ?, avatar_color = ? WHERE id = ?')
      .run(displayName, avatarColor, req.user.id);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const friendIds = db.prepare('SELECT friend_id FROM friendships WHERE user_id = ?')
      .all(req.user.id).map((row) => row.friend_id);
    for (const friendId of friendIds) emitToUser(friendId, 'friends:changed');
    emitToUser(req.user.id, 'profile:updated', { user: publicUser(user) });
    res.json({ user: publicUser(user) });
  });

  router.get('/bootstrap', (req, res) => {
    res.json({
      user: publicUser(req.user),
      friends: listFriends(req.user.id),
      requests: listRequests(req.user.id),
      conversations: listConversations(req.user.id),
      games: listGames()
    });
  });

  router.get('/users/search', (req, res) => {
    const query = String(req.query.q || '').trim().slice(0, 30);
    if (!query) return res.json({ users: [] });
    const users = db.prepare(`SELECT * FROM users WHERE id <> ? AND
      (username LIKE ? OR display_name LIKE ?) ORDER BY display_name LIMIT 12`)
      .all(req.user.id, `%${query}%`, `%${query}%`).map((user) => ({
        ...publicUser(user),
        isFriend: Boolean(db.prepare('SELECT 1 FROM friendships WHERE user_id = ? AND friend_id = ?').get(req.user.id, user.id)),
        requestPending: Boolean(db.prepare(`SELECT 1 FROM friend_requests
          WHERE status = 'pending' AND ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))`)
          .get(req.user.id, user.id, user.id, req.user.id))
      }));
    res.json({ users });
  });

  router.get('/friends', (req, res) => {
    res.json({ friends: listFriends(req.user.id), requests: listRequests(req.user.id) });
  });

  router.post('/friends/requests', (req, res) => {
    const username = String(req.body?.username || '').trim();
    let target = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
    if (!target) {
      const matches = db.prepare('SELECT * FROM users WHERE display_name = ? LIMIT 2').all(username);
      if (matches.length > 1) return fail(res, 409, '这个昵称对应多个用户，请改用完整用户名添加');
      target = matches[0];
    }
    if (!target) return fail(res, 404, '没有找到这个用户，请检查完整用户名');
    if (target.id === req.user.id) return fail(res, 400, '不能添加自己为好友');
    if (db.prepare('SELECT 1 FROM friendships WHERE user_id = ? AND friend_id = ?').get(req.user.id, target.id)) {
      return fail(res, 409, '你们已经是好友了');
    }
    const reverse = db.prepare(`SELECT id FROM friend_requests WHERE sender_id = ? AND recipient_id = ? AND status = 'pending'`)
      .get(target.id, req.user.id);
    if (reverse) return fail(res, 409, '对方已经向你发送好友请求，请在好友通知中接受');
    const existing = db.prepare('SELECT * FROM friend_requests WHERE sender_id = ? AND recipient_id = ?').get(req.user.id, target.id);
    let requestId;
    if (existing?.status === 'pending') return fail(res, 409, '好友请求已发送，请等待对方处理');
    if (existing) {
      db.prepare("UPDATE friend_requests SET status = 'pending', created_at = ? WHERE id = ?").run(now(), existing.id);
      requestId = existing.id;
    } else {
      requestId = Number(db.prepare('INSERT INTO friend_requests (sender_id, recipient_id, created_at) VALUES (?, ?, ?)')
        .run(req.user.id, target.id, now()).lastInsertRowid);
    }
    emitToUser(target.id, 'friends:changed');
    emitToUser(req.user.id, 'friends:changed');
    res.status(201).json({ requestId, message: `已向 ${target.display_name} 发送好友请求` });
  });

  router.post('/friends/requests/:id/accept', (req, res) => {
    const id = numericId(req.params.id);
    const request = db.prepare('SELECT * FROM friend_requests WHERE id = ? AND recipient_id = ?').get(id, req.user.id);
    if (!request || request.status !== 'pending') return fail(res, 404, '好友请求不存在或已处理');
    db.transaction(() => {
      db.prepare("UPDATE friend_requests SET status = 'accepted' WHERE id = ?").run(id);
      const add = db.prepare('INSERT OR IGNORE INTO friendships (user_id, friend_id, created_at) VALUES (?, ?, ?)');
      add.run(req.user.id, request.sender_id, now());
      add.run(request.sender_id, req.user.id, now());
    })();
    emitToUser(req.user.id, 'friends:changed');
    emitToUser(request.sender_id, 'friends:changed');
    res.json({ ok: true });
  });

  router.post('/friends/requests/:id/decline', (req, res) => {
    const id = numericId(req.params.id);
    const result = db.prepare(`UPDATE friend_requests SET status = 'declined'
      WHERE id = ? AND recipient_id = ? AND status = 'pending'`).run(id, req.user.id);
    if (!result.changes) return fail(res, 404, '好友请求不存在或已处理');
    emitToUser(req.user.id, 'friends:changed');
    res.json({ ok: true });
  });

  router.get('/conversations', (req, res) => res.json({ conversations: listConversations(req.user.id) }));

  router.post('/conversations/private', (req, res) => {
    const friendId = numericId(req.body?.userId);
    if (!friendId) return fail(res, 400, '无效的用户');
    if (!db.prepare('SELECT 1 FROM friendships WHERE user_id = ? AND friend_id = ?').get(req.user.id, friendId)) {
      return fail(res, 403, '添加好友后才能发起私聊');
    }
    const row = createPrivateConversation(req.user.id, friendId);
    const conversation = serializeConversation(row, req.user.id);
    notifyConversation(row.id, 'conversation:new', { conversationId: row.id });
    res.status(201).json({ conversation });
  });

  router.post('/conversations/group', (req, res) => {
    const name = String(req.body?.name || '').trim();
    const memberIds = [...new Set((Array.isArray(req.body?.memberIds) ? req.body.memberIds : []).map(numericId).filter(Boolean))];
    if (name.length < 2 || name.length > 30) return fail(res, 400, '群名称需为 2–30 个字符');
    if (memberIds.length < 1 || memberIds.length > 20) return fail(res, 400, '请选择 1–20 位好友加入群聊');
    const validFriends = db.prepare(`SELECT friend_id FROM friendships WHERE user_id = ?`).all(req.user.id).map((row) => row.friend_id);
    if (memberIds.some((id) => !validFriends.includes(id))) return fail(res, 400, '群成员必须都是你的好友');
    const conversationId = db.transaction(() => {
      const groupId = Number(db.prepare('INSERT INTO chat_groups (name, owner_id, created_at) VALUES (?, ?, ?)')
        .run(name, req.user.id, now()).lastInsertRowid);
      const id = Number(db.prepare('INSERT INTO conversations (type, group_id, created_at) VALUES (?, ?, ?)')
        .run('group', groupId, now()).lastInsertRowid);
      const add = db.prepare('INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)');
      add.run(id, req.user.id, 'owner');
      for (const memberId of memberIds) add.run(id, memberId, 'member');
      db.prepare('INSERT INTO messages (conversation_id, sender_id, body, created_at) VALUES (?, ?, ?, ?)')
        .run(id, req.user.id, `创建了群聊「${name}」`, now());
      return id;
    })();
    notifyConversation(conversationId, 'conversation:new', { conversationId });
    const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
    res.status(201).json({ conversation: serializeConversation(row, req.user.id) });
  });

  router.post('/conversations/:id/members', (req, res) => {
    const conversationId = numericId(req.params.id);
    const userId = numericId(req.body?.userId);
    const row = db.prepare('SELECT * FROM conversations WHERE id = ? AND type = ?').get(conversationId, 'group');
    if (!row || !isMember(conversationId, req.user.id)) return fail(res, 404, '群聊不存在');
    const group = db.prepare('SELECT * FROM chat_groups WHERE id = ?').get(row.group_id);
    if (group.owner_id !== req.user.id) return fail(res, 403, '只有群主可以添加成员');
    if (isMember(conversationId, userId)) return fail(res, 409, '该用户已经在群聊中');
    if (!db.prepare('SELECT 1 FROM friendships WHERE user_id = ? AND friend_id = ?').get(req.user.id, userId)) {
      return fail(res, 400, '只能添加你的好友进入群聊');
    }
    db.prepare('INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)').run(conversationId, userId);
    notifyConversation(conversationId, 'conversation:new', { conversationId });
    res.status(201).json({ ok: true });
  });

  router.delete('/conversations/:id/members/:userId', (req, res) => {
    const conversationId = numericId(req.params.id);
    const userId = numericId(req.params.userId);
    const row = db.prepare('SELECT * FROM conversations WHERE id = ? AND type = ?').get(conversationId, 'group');
    if (!row || !isMember(conversationId, req.user.id)) return fail(res, 404, '群聊不存在');
    const group = db.prepare('SELECT * FROM chat_groups WHERE id = ?').get(row.group_id);
    if (group.owner_id !== req.user.id) return fail(res, 403, '只有群主可以移除成员');
    if (userId === req.user.id) return fail(res, 400, '群主不能移除自己，请使用退出群聊');
    if (!isMember(conversationId, userId)) return fail(res, 404, '该成员不在群聊中');
    db.prepare('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?').run(conversationId, userId);
    notifyConversation(conversationId, 'conversation:new', { conversationId });
    res.json({ ok: true });
  });

  router.post('/conversations/:id/leave', (req, res) => {
    const conversationId = numericId(req.params.id);
    const row = db.prepare('SELECT * FROM conversations WHERE id = ? AND type = ?').get(conversationId, 'group');
    if (!row || !isMember(conversationId, req.user.id)) return fail(res, 404, '群聊不存在或你不在其中');
    const group = db.prepare('SELECT * FROM chat_groups WHERE id = ?').get(row.group_id);
    const memberIds = conversationMemberIds(conversationId);
    db.transaction(() => {
      if (group.owner_id === req.user.id && memberIds.length > 1) {
        const successor = db.prepare(`SELECT user_id FROM conversation_members
          WHERE conversation_id = ? AND user_id <> ? ORDER BY role DESC, user_id LIMIT 1`)
          .get(conversationId, req.user.id).user_id;
        db.prepare('UPDATE chat_groups SET owner_id = ? WHERE id = ?').run(successor, row.group_id);
        db.prepare(`UPDATE conversation_members SET role = 'owner'
          WHERE conversation_id = ? AND user_id = ?`).run(conversationId, successor);
        db.prepare(`UPDATE conversation_members SET role = 'member'
          WHERE conversation_id = ? AND user_id = ?`).run(conversationId, req.user.id);
      }
      db.prepare('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
        .run(conversationId, req.user.id);
      if (memberIds.length === 1) db.prepare('DELETE FROM conversations WHERE id = ?').run(conversationId);
    })();
    for (const userId of memberIds) emitToUser(userId, 'conversation:new', { conversationId });
    res.json({ ok: true, dissolved: memberIds.length === 1 });
  });

  router.get('/conversations/:id/messages', (req, res) => {
    const conversationId = numericId(req.params.id);
    if (!conversationId || !isMember(conversationId, req.user.id)) return fail(res, 404, '会话不存在或你不在其中');
    const before = numericId(req.query.before);
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const rows = before ? db.prepare(`SELECT m.*, u.username, u.display_name, u.avatar_color,
      f.original_name, f.size, f.mime FROM messages m JOIN users u ON u.id = m.sender_id
      LEFT JOIN files f ON f.id = m.attachment_id
      WHERE m.conversation_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`).all(conversationId, before, limit)
      : db.prepare(`SELECT m.*, u.username, u.display_name, u.avatar_color,
      f.original_name, f.size, f.mime FROM messages m JOIN users u ON u.id = m.sender_id
      LEFT JOIN files f ON f.id = m.attachment_id
      WHERE m.conversation_id = ? ORDER BY m.id DESC LIMIT ?`).all(conversationId, limit);
    res.json({ messages: rows.reverse().map(serializeMessage), hasMore: rows.length === limit });
  });

  router.post('/conversations/:id/read', (req, res) => {
    const conversationId = numericId(req.params.id);
    if (!conversationId || !isMember(conversationId, req.user.id)) return fail(res, 404, '会话不存在');
    const latest = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE conversation_id = ?').get(conversationId).id;
    db.prepare(`UPDATE conversation_members SET last_read_message_id = ?
      WHERE conversation_id = ? AND user_id = ?`).run(latest, conversationId, req.user.id);
    notifyConversation(conversationId, 'message:read', {
      conversationId, userId: req.user.id, lastReadMessageId: latest
    });
    res.json({ ok: true, lastReadMessageId: latest });
  });

  router.post('/conversations/:id/messages', (req, res) => {
    const conversationId = numericId(req.params.id);
    const body = String(req.body?.body || '').trim();
    if (!conversationId || !isMember(conversationId, req.user.id)) return fail(res, 404, '会话不存在或你不在其中');
    if (!body) return fail(res, 400, '消息不能为空');
    if (body.length > 2000) return fail(res, 400, '单条消息不能超过 2000 个字符');
    const messageId = db.transaction(() => {
      const id = Number(db.prepare('INSERT INTO messages (conversation_id, sender_id, body, created_at) VALUES (?, ?, ?, ?)')
        .run(conversationId, req.user.id, body, now()).lastInsertRowid);
      db.prepare('UPDATE conversation_members SET last_read_message_id = ? WHERE conversation_id = ? AND user_id = ?')
        .run(id, conversationId, req.user.id);
      return id;
    })();
    const message = getMessage(messageId);
    notifyConversation(conversationId, 'message:new', { message });
    res.status(201).json({ message });
  });

  router.delete('/conversations/:id/messages/:messageId', (req, res) => {
    const conversationId = numericId(req.params.id);
    const messageId = numericId(req.params.messageId);
    if (!conversationId || !isMember(conversationId, req.user.id)) {
      return fail(res, 404, '会话不存在或你不在其中');
    }
    const message = db.prepare('SELECT * FROM messages WHERE id = ? AND conversation_id = ?')
      .get(messageId, conversationId);
    if (!message) return fail(res, 404, '消息不存在');
    if (message.sender_id !== req.user.id) return fail(res, 403, '只能撤回自己发送的消息');
    let attachment = null;
    if (message.attachment_id) {
      attachment = db.prepare('SELECT * FROM files WHERE id = ?').get(message.attachment_id);
    }
    db.transaction(() => {
      db.prepare('DELETE FROM messages WHERE id = ?').run(messageId);
      if (attachment) db.prepare('DELETE FROM files WHERE id = ?').run(attachment.id);
    })();
    if (attachment) removeUpload(attachment.stored_name);
    notifyConversation(conversationId, 'message:deleted', { conversationId, messageId });
    res.json({ ok: true });
  });

  const checkConversationUpload = (req, res, next) => {
    const conversationId = numericId(req.params.id);
    if (!conversationId || !isMember(conversationId, req.user.id)) return fail(res, 404, '会话不存在或你不在其中');
    next();
  };

  router.post('/conversations/:id/files', checkConversationUpload, uploadLimiter, upload.single('file'), (req, res) => {
    const conversationId = numericId(req.params.id);
    if (!req.file) return fail(res, 400, '请选择要发送的文件');
    const quota = checkStorage(req.user.id, req.file.size);
    if (!quota.allowed) {
      removeUpload(req.file.filename);
      return fail(res, 413, '个人文件空间不足，请先清理文件');
    }
    const body = String(req.body?.body || '').trim().slice(0, 2000);
    const originalName = cleanOriginalName(req.file.originalname);
    try {
      const messageId = db.transaction(() => {
        const fileId = Number(db.prepare(`INSERT INTO files
          (owner_id, conversation_id, original_name, stored_name, mime, size, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(req.user.id, conversationId, originalName,
          req.file.filename, req.file.mimetype || 'application/octet-stream', req.file.size, now()).lastInsertRowid);
        const id = Number(db.prepare(`INSERT INTO messages
          (conversation_id, sender_id, body, attachment_id, created_at) VALUES (?, ?, ?, ?, ?)`)
          .run(conversationId, req.user.id, body, fileId, now()).lastInsertRowid);
        db.prepare('UPDATE conversation_members SET last_read_message_id = ? WHERE conversation_id = ? AND user_id = ?')
          .run(id, conversationId, req.user.id);
        return id;
      })();
      const message = getMessage(messageId);
      notifyConversation(conversationId, 'message:new', { message });
      res.status(201).json({ message });
    } catch (error) {
      removeUpload(req.file.filename);
      throw error;
    }
  });

  router.get('/files', (req, res) => {
    const files = db.prepare(`SELECT f.*, c.type AS conversation_type FROM files f
      LEFT JOIN conversations c ON c.id = f.conversation_id
      WHERE f.owner_id = ? ORDER BY f.id DESC`).all(req.user.id).map((file) => ({
        id: file.id,
        original_name: file.original_name,
        size: file.size,
        mime: file.mime,
        created_at: file.created_at,
        shared: Boolean(file.conversation_id),
        deletable: !db.prepare('SELECT 1 FROM messages WHERE attachment_id = ?').get(file.id),
        download_url: `/api/files/${file.id}/download`
      }));
    const used = db.prepare('SELECT COALESCE(SUM(size), 0) AS total FROM files WHERE owner_id = ?').get(req.user.id).total;
    res.json({ files, used, limit: MAX_STORAGE, maxFileSize: MAX_FILE_SIZE });
  });

  router.post('/files', uploadLimiter, upload.single('file'), (req, res) => {
    if (!req.file) return fail(res, 400, '请选择要上传的文件');
    const quota = checkStorage(req.user.id, req.file.size);
    if (!quota.allowed) {
      removeUpload(req.file.filename);
      return fail(res, 413, '个人文件空间不足，请先清理文件');
    }
    const originalName = cleanOriginalName(req.file.originalname);
    try {
      const result = db.prepare(`INSERT INTO files
        (owner_id, conversation_id, original_name, stored_name, mime, size, created_at)
        VALUES (?, NULL, ?, ?, ?, ?, ?)`).run(req.user.id, originalName, req.file.filename,
        req.file.mimetype || 'application/octet-stream', req.file.size, now());
      res.status(201).json({ fileId: Number(result.lastInsertRowid), message: '文件已上传，可在其他设备下载' });
    } catch (error) {
      removeUpload(req.file.filename);
      throw error;
    }
  });

  router.get('/files/:id/download', (req, res) => {
    const fileId = numericId(req.params.id);
    const file = db.prepare('SELECT * FROM files WHERE id = ?').get(fileId);
    if (!file) return fail(res, 404, '文件不存在');
    const allowed = file.owner_id === req.user.id || (file.conversation_id && isMember(file.conversation_id, req.user.id));
    if (!allowed) return fail(res, 403, '你没有下载这个文件的权限');
    const filePath = safeUploadPath(file.stored_name);
    if (!fs.existsSync(filePath)) return fail(res, 410, '文件已不在服务器中');
    res.download(filePath, file.original_name);
  });

  router.delete('/files/:id', (req, res) => {
    const fileId = numericId(req.params.id);
    const file = db.prepare('SELECT * FROM files WHERE id = ? AND owner_id = ?').get(fileId, req.user.id);
    if (!file) return fail(res, 404, '文件不存在');
    if (db.prepare('SELECT 1 FROM messages WHERE attachment_id = ?').get(file.id)) {
      return fail(res, 409, '聊天中引用的文件不能单独删除');
    }
    db.prepare('DELETE FROM files WHERE id = ?').run(file.id);
    removeUpload(file.stored_name);
    res.json({ ok: true });
  });

  // ---------- 朋友圈 ----------
  const visibleMomentRows = (userId, before, limit) => {
    const condition = `(m.user_id = ? OR m.visibility = 'public' OR
      (m.visibility = 'friends' AND m.user_id IN (SELECT friend_id FROM friendships WHERE user_id = ?)))`;
    return before
      ? db.prepare(`SELECT m.* FROM moments m WHERE ${condition} AND m.id < ? ORDER BY m.id DESC LIMIT ?`)
        .all(userId, userId, before, limit)
      : db.prepare(`SELECT m.* FROM moments m WHERE ${condition} ORDER BY m.id DESC LIMIT ?`)
        .all(userId, userId, limit);
  };
  const visibleMomentOr404 = (res, id, userId) => {
    const row = getMomentRow(numericId(id));
    if (!row || !canViewMoment(row, userId)) {
      fail(res, 404, '动态不存在或你不可见');
      return null;
    }
    return row;
  };

  router.get('/moments', (req, res) => {
    const before = numericId(req.query.before);
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const rows = visibleMomentRows(req.user.id, before, limit);
    const latest = db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM moments
      WHERE visibility <> 'private'`).get().id;
    res.json({
      moments: rows.map((row) => serializeMoment(row, req.user.id)),
      hasMore: rows.length === limit,
      latestId: latest
    });
  });

  // 互动消息由点赞与评论记录直接汇总，不另存一份可能不同步的通知数据。
  router.get('/moments/notifications', (req, res) => {
    const rows = db.prepare(`
      SELECT type, moment_id, actor_id, display_name, avatar_color, body, created_at, moment_body FROM (
        SELECT 'like' AS type, l.moment_id, l.user_id AS actor_id, u.display_name,
          u.avatar_color, '' AS body, l.created_at AS created_at, m.body AS moment_body
        FROM moment_likes l JOIN moments m ON m.id = l.moment_id JOIN users u ON u.id = l.user_id
        WHERE m.user_id = ? AND l.user_id <> ?
        UNION ALL
        SELECT 'comment' AS type, c.moment_id, c.user_id AS actor_id, u.display_name,
          u.avatar_color, c.body AS body, c.created_at AS created_at, m.body AS moment_body
        FROM moment_comments c JOIN moments m ON m.id = c.moment_id JOIN users u ON u.id = c.user_id
        WHERE m.user_id = ? AND c.user_id <> ?
      ) ORDER BY created_at DESC LIMIT 20`).all(req.user.id, req.user.id, req.user.id, req.user.id);
    res.json({ notifications: rows, latestAt: rows[0]?.created_at || null });
  });

  // 图片按动态可见范围鉴权，静态目录从不直接暴露。
  router.get('/moments/media/:id', (req, res) => {
    const media = db.prepare(`SELECT mm.*, m.user_id AS author_id, m.visibility
      FROM moment_media mm JOIN moments m ON m.id = mm.moment_id WHERE mm.id = ?`)
      .get(numericId(req.params.id));
    if (!media || !canViewMoment({ user_id: media.author_id, visibility: media.visibility }, req.user.id)) {
      return fail(res, 404, '图片不存在');
    }
    const filePath = safeUploadPath(media.stored_name);
    if (!fs.existsSync(filePath)) return fail(res, 410, '图片已不在服务器中');
    res.set('Content-Type', media.mime);
    res.set('Content-Length', String(media.size));
    res.set('Cache-Control', 'private, max-age=86400');
    fs.createReadStream(filePath).pipe(res);
  });

  router.post('/moments', uploadLimiter, momentImageUpload.array('images', MAX_MOMENT_IMAGES), (req, res) => {
    const body = String(req.body?.body || '').trim();
    const visibility = String(req.body?.visibility || 'friends');
    const images = req.files || [];
    const cleanup = () => images.forEach((image) => removeUpload(image.filename));
    if (!MOMENT_VISIBILITIES.includes(visibility)) {
      cleanup();
      return fail(res, 400, '可见范围无效');
    }
    if (body.length > 2000) {
      cleanup();
      return fail(res, 400, '动态文字不能超过 2000 个字符');
    }
    if (!body && !images.length) {
      cleanup();
      return fail(res, 400, '写点什么，或至少选一张图片');
    }
    if (images.some((image) => !MOMENT_IMAGE_TYPES.has(image.mimetype))) {
      cleanup();
      return fail(res, 400, '仅支持 JPG、PNG、GIF、WebP 图片');
    }
    if (images.reduce((sum, image) => sum + image.size, 0) > MAX_MOMENT_TOTAL_SIZE) {
      cleanup();
      return fail(res, 413, '一次最多上传 20 MB 图片');
    }
    try {
      const momentId = db.transaction(() => {
        const id = Number(db.prepare(`INSERT INTO moments (user_id, body, visibility, created_at)
          VALUES (?, ?, ?, ?)`).run(req.user.id, body, visibility, now()).lastInsertRowid);
        const addMedia = db.prepare(`INSERT INTO moment_media
          (moment_id, stored_name, mime, size, position, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
        images.forEach((image, index) => addMedia.run(
          id, image.filename, image.mimetype, image.size, index, now()
        ));
        return id;
      })();
      notifyMomentChange(momentId, req.user.id, visibility);
      res.status(201).json({ moment: serializeMoment(getMomentRow(momentId), req.user.id) });
    } catch (error) {
      cleanup();
      throw error;
    }
  });

  router.delete('/moments/:id', (req, res) => {
    const momentId = numericId(req.params.id);
    const row = getMomentRow(momentId);
    if (!row || row.user_id !== req.user.id) return fail(res, 404, '动态不存在或不是你发布的');
    const media = db.prepare('SELECT stored_name FROM moment_media WHERE moment_id = ?').all(momentId);
    db.prepare('DELETE FROM moments WHERE id = ?').run(momentId);
    media.forEach((item) => removeUpload(item.stored_name));
    notifyMomentChange(momentId, row.user_id, row.visibility);
    res.json({ ok: true });
  });

  router.post('/moments/:id/like', (req, res) => {
    const row = visibleMomentOr404(res, req.params.id, req.user.id);
    if (!row) return;
    db.prepare('INSERT OR IGNORE INTO moment_likes (moment_id, user_id, created_at) VALUES (?, ?, ?)')
      .run(row.id, req.user.id, now());
    notifyMomentChange(row.id, row.user_id, row.visibility);
    notifyMomentActivity(row, req.user.id, 'like');
    res.json({ liked: true, likes: serializeMoment(row, req.user.id).likes });
  });

  router.delete('/moments/:id/like', (req, res) => {
    const row = visibleMomentOr404(res, req.params.id, req.user.id);
    if (!row) return;
    db.prepare('DELETE FROM moment_likes WHERE moment_id = ? AND user_id = ?').run(row.id, req.user.id);
    notifyMomentChange(row.id, row.user_id, row.visibility);
    res.json({ liked: false, likes: serializeMoment(row, req.user.id).likes });
  });

  router.post('/moments/:id/comments', (req, res) => {
    const row = visibleMomentOr404(res, req.params.id, req.user.id);
    if (!row) return;
    const body = String(req.body?.body || '').trim();
    if (!body || body.length > 500) return fail(res, 400, '评论需为 1–500 个字符');
    let replyToUserId = null;
    if (req.body?.replyToUserId !== undefined && req.body?.replyToUserId !== null && req.body?.replyToUserId !== '') {
      replyToUserId = numericId(req.body.replyToUserId);
      if (!replyToUserId || !db.prepare('SELECT 1 FROM users WHERE id = ?').get(replyToUserId)) {
        return fail(res, 400, '回复对象无效');
      }
    }
    db.prepare(`INSERT INTO moment_comments (moment_id, user_id, body, reply_to_user_id, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(row.id, req.user.id, body, replyToUserId, now());
    notifyMomentChange(row.id, row.user_id, row.visibility);
    notifyMomentActivity(row, req.user.id, 'comment');
    const comments = serializeMoment(row, req.user.id).comments;
    res.status(201).json({ comment: comments.at(-1) });
  });

  router.delete('/moments/:id/comments/:commentId', (req, res) => {
    const row = visibleMomentOr404(res, req.params.id, req.user.id);
    if (!row) return;
    const commentId = numericId(req.params.commentId);
    const comment = db.prepare('SELECT * FROM moment_comments WHERE id = ? AND moment_id = ?')
      .get(commentId, row.id);
    if (!comment) return fail(res, 404, '评论不存在');
    if (comment.user_id !== req.user.id && row.user_id !== req.user.id) {
      return fail(res, 403, '只能删除自己的评论或自己动态下的评论');
    }
    db.prepare('DELETE FROM moment_comments WHERE id = ?').run(commentId);
    notifyMomentChange(row.id, row.user_id, row.visibility);
    res.json({ ok: true });
  });

  router.get('/cloud/games', (req, res) => {
    res.json({
      games: listGames(),
      websiteLogin: { persistent: true, durationDays: 30 },
      notice: '游戏由厂商官方云游戏网页版直接运行，云屿只负责打开入口。官方不向第三方开放单点登录，游戏账号需在厂商页面自行登录；网站登录状态不等于游戏免登。'
    });
  });

  // 返回经过校验的真实启动地址。官方入口内置可直接使用；部署者也可通过
  // CLOUD_*_URL 指向自己有权使用的服务（*_SSO / *_EMBED 仅对该类服务生效）。
  router.post('/cloud/games/:id/launch', (req, res) => {
    const game = getGame(req.params.id);
    if (!game) return fail(res, 404, '未找到这个游戏');
    if (!game.configured || !game.launchUrl) return fail(res, 409, '该游戏的云游戏服务地址配置无效');
    res.json({
      launchUrl: game.launchUrl,
      name: game.cloudName,
      officialHost: game.officialHost,
      source: game.source,
      mode: game.mode,
      singleSignOn: game.ssoConfigured,
      requiresGameLogin: game.requiresGameLogin,
      message: game.source === 'official'
        ? `已打开${game.provider}的${game.cloudName}网页版，请在官方页面登录${game.account}后开始游戏`
        : (game.ssoConfigured ? '已接入自建服务，免登结果以服务返回为准' : '即将打开自建云游戏服务，可能仍需登录')
    });
  });

  return router;
}

module.exports = { createApiRouter, MAX_FILE_SIZE, MAX_STORAGE };
