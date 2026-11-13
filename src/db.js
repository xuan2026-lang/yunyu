const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const now = () => new Date().toISOString();

function createDatabase(dataDir, { seed = true } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
  const db = new Database(path.join(dataDir, 'yunyu.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      avatar_color TEXT NOT NULL DEFAULT '#547568',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS friend_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined')),
      created_at TEXT NOT NULL,
      UNIQUE(sender_id, recipient_id)
    );
    CREATE TABLE IF NOT EXISTS friendships (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      friend_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY(user_id, friend_id),
      CHECK(user_id <> friend_id)
    );
    CREATE TABLE IF NOT EXISTS chat_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('private','group')),
      private_key TEXT UNIQUE,
      group_id INTEGER UNIQUE REFERENCES chat_groups(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversation_members (
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner','member')),
      last_read_message_id INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(conversation_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL UNIQUE,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_files_owner ON files(owner_id);
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL DEFAULT '',
      attachment_id INTEGER REFERENCES files(id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id);
    CREATE TABLE IF NOT EXISTS moments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL DEFAULT '',
      visibility TEXT NOT NULL DEFAULT 'friends' CHECK(visibility IN ('friends','private','public')),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_moments_user ON moments(user_id, id DESC);
    CREATE TABLE IF NOT EXISTS moment_media (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      moment_id INTEGER NOT NULL REFERENCES moments(id) ON DELETE CASCADE,
      stored_name TEXT NOT NULL UNIQUE,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS moment_likes (
      moment_id INTEGER NOT NULL REFERENCES moments(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY(moment_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS moment_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      moment_id INTEGER NOT NULL REFERENCES moments(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      reply_to_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_moment_comments ON moment_comments(moment_id, id);
  `);
  if (seed) {
    seedDatabase(db, dataDir);
    seedMomentsIfEmpty(db);
  }
  return db;
}

// 首次升级到带朋友圈的版本时，给演示账号补几条动态；不覆盖用户已发布的内容。
function seedMomentsIfEmpty(db) {
  if (db.prepare('SELECT COUNT(*) AS count FROM moments').get().count > 0) return;
  const demo = db.prepare("SELECT id FROM users WHERE username = 'demo'").get();
  if (!demo) return;
  const find = (username) => db.prepare('SELECT id FROM users WHERE username = ?').get(username)?.id;
  const aCheng = find('a_cheng');
  const yeZi = find('ye_zi');
  if (!aCheng || !yeZi) return;
  const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60000).toISOString();
  db.transaction(() => {
    const addMoment = db.prepare('INSERT INTO moments (user_id, body, visibility, created_at) VALUES (?, ?, ?, ?)');
    const first = Number(addMoment.run(aCheng, '周末爬山拍的照片整理好了，传到文件空间，换台电脑直接就能下载。', 'friends', at(185)).lastInsertRowid);
    const second = Number(addMoment.run(yeZi, '今天在网页版云·原神里跑了一会儿，进度和客户端是互通的，太方便了。', 'friends', at(96)).lastInsertRowid);
    const third = Number(addMoment.run(demo.id, '聊天、文件、游戏都放在一个地方，界面清清爽爽的。', 'friends', at(38)).lastInsertRowid);
    addMoment.run(aCheng, '给自己记一笔：下周把相册整理完。', 'private', at(12));
    const like = db.prepare('INSERT INTO moment_likes (moment_id, user_id, created_at) VALUES (?, ?, ?)');
    like.run(first, demo.id, at(180));
    like.run(first, yeZi, at(170));
    like.run(second, demo.id, at(90));
    like.run(third, aCheng, at(30));
    const comment = db.prepare('INSERT INTO moment_comments (moment_id, user_id, body, created_at) VALUES (?, ?, ?, ?)');
    comment.run(first, demo.id, '照片拍得真好！下次一起～', at(178));
    comment.run(third, yeZi, '同感，界面很舒服。', at(24));
  })();
}

function seedDatabase(db, dataDir) {
  if (db.prepare('SELECT COUNT(*) AS count FROM users').get().count > 0) return;
  const passwordHash = bcrypt.hashSync('Demo123!', 10);
  const insertUser = db.prepare(`INSERT INTO users
    (username, display_name, password_hash, avatar_color, created_at)
    VALUES (?, ?, ?, ?, ?)`);
  const users = [
    ['demo', '演示用户', '#4f7568'],
    ['a_cheng', '阿澄', '#a46f52'],
    ['ye_zi', '叶子', '#657b9b'],
    ['lin_yi', '林一', '#8a6f8e']
  ];
  const timestamp = now();
  const seedAll = db.transaction(() => {
    for (const [username, displayName, color] of users) {
      insertUser.run(username, displayName, passwordHash, color, timestamp);
    }
    const addFriend = db.prepare('INSERT INTO friendships (user_id, friend_id, created_at) VALUES (?, ?, ?)');
    for (const [a, b] of [[1, 2], [2, 1], [1, 3], [3, 1]]) addFriend.run(a, b, timestamp);

    const addConversation = db.prepare('INSERT INTO conversations (type, private_key, group_id, created_at) VALUES (?, ?, ?, ?)');
    const addMember = db.prepare('INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)');
    const addMessage = db.prepare('INSERT INTO messages (conversation_id, sender_id, body, created_at) VALUES (?, ?, ?, ?)');

    const privateOne = Number(addConversation.run('private', '1:2', null, timestamp).lastInsertRowid);
    addMember.run(privateOne, 1, 'member');
    addMember.run(privateOne, 2, 'member');
    addMessage.run(privateOne, 2, '欢迎来到云屿，这里可以聊天，也能直接发文件。', timestamp);
    addMessage.run(privateOne, 1, '界面很清爽，晚些时候试试一起云游戏。', now());

    const privateTwo = Number(addConversation.run('private', '1:3', null, timestamp).lastInsertRowid);
    addMember.run(privateTwo, 1, 'member');
    addMember.run(privateTwo, 3, 'member');
    addMessage.run(privateTwo, 3, '我把旅行照片放到文件空间里，换台电脑也能下载。', timestamp);

    const group = db.prepare('INSERT INTO chat_groups (name, owner_id, created_at) VALUES (?, ?, ?)')
      .run('周末游戏搭子', 1, timestamp);
    const groupId = Number(group.lastInsertRowid);
    const groupConversation = Number(addConversation.run('group', null, groupId, timestamp).lastInsertRowid);
    addMember.run(groupConversation, 1, 'owner');
    addMember.run(groupConversation, 2, 'member');
    addMember.run(groupConversation, 3, 'member');
    addMessage.run(groupConversation, 1, '这个群用来约游戏和分享攻略，文件也可以直接发在这里。', timestamp);
    addMessage.run(groupConversation, 2, '收到，周末见。', now());
  });
  seedAll();

  const welcomeName = '云屿使用说明.txt';
  const storedName = 'welcome-demo.txt';
  const welcomePath = path.join(dataDir, 'uploads', storedName);
  const content = '欢迎来到云屿！\r\n\r\n你可以在不同设备登录同一账号，上传、查看和下载自己的文件。\r\n聊天中的附件只有会话成员可以下载。\r\n云游戏的真实启动与免登能力需要另行配置官方服务。\r\n';
  fs.writeFileSync(welcomePath, content, 'utf8');
  db.prepare(`INSERT INTO files
    (owner_id, conversation_id, original_name, stored_name, mime, size, created_at)
    VALUES (?, NULL, ?, ?, ?, ?, ?)`)
    .run(1, welcomeName, storedName, 'text/plain; charset=utf-8', Buffer.byteLength(content), now());
}

module.exports = { createDatabase, now };
