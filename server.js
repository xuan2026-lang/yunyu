const http = require('node:http');
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const { Server } = require('socket.io');
const { createDatabase } = require('./src/db');
const { attachUser, getUserByToken, parseCookieHeader, SESSION_COOKIE } = require('./src/auth');
const { createApiRouter } = require('./src/api');

function createApplication(options = {}) {
  const dataDir = options.dataDir || process.env.DATA_DIR || path.join(__dirname, 'data');
  const uploadDir = path.join(dataDir, 'uploads');
  const seed = options.seed !== undefined
    ? options.seed
    : process.env.SEED_DEMO
      ? process.env.SEED_DEMO === '1'
      : process.env.NODE_ENV !== 'production';
  const db = createDatabase(dataDir, { seed });
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, {
    maxHttpBufferSize: 1e6,
    pingTimeout: 20000,
    cors: { origin: false }
  });

  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // 进度条宽度、输入框自适应高度等由 JS 写入 element.style，需要允许内联样式属性。
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        // 自建云游戏服务可在启动台内嵌入；官方网页版一律在新标签页打开。
        frameSrc: ["'self'", 'https:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"]
      }
    },
    crossOriginResourcePolicy: { policy: 'same-origin' }
  }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(attachUser(db));
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.get('origin');
    if (origin) {
      try {
        if (new URL(origin).host !== req.get('host')) {
          return res.status(403).json({ error: '已阻止跨站请求' });
        }
      } catch {
        return res.status(403).json({ error: '请求来源无效' });
      }
    }
    if (req.get('x-requested-with') !== 'XMLHttpRequest') {
      return res.status(403).json({ error: '请求缺少安全校验头' });
    }
    next();
  });
  app.use('/api', createApiRouter({ db, uploadDir, io }));
  app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }));
  app.use(express.static(path.join(__dirname, 'public'), { etag: true, maxAge: 0 }));
  app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

  app.use((error, req, res, _next) => {
    if (error instanceof multer.MulterError) {
      const isMoment = req.path?.startsWith('/moments');
      const message = error.code === 'LIMIT_FILE_SIZE'
        ? (isMoment ? '单张图片不能超过 5 MB' : '单个文件不能超过 25 MB')
        : (error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE')
          ? (isMoment ? '一次最多上传 9 张图片' : '一次只能上传 1 个文件')
          : '文件上传失败，请重试';
      return res.status(413).json({ error: message });
    }
    if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
      return res.status(400).json({ error: '请求数据格式不正确' });
    }
    console.error('服务器错误:', error);
    if (res.headersSent) return;
    res.status(500).json({ error: '服务器暂时无法处理请求，请稍后重试' });
  });

  const onlineCounts = new Map();
  const broadcastPresence = () => io.emit('presence:update', {
    onlineUserIds: [...onlineCounts.entries()].filter(([, count]) => count > 0).map(([id]) => id)
  });

  io.use((socket, next) => {
    const cookies = parseCookieHeader(socket.handshake.headers.cookie);
    const user = getUserByToken(db, cookies[SESSION_COOKIE]);
    if (!user) return next(new Error('登录状态已失效'));
    socket.user = user;
    next();
  });

  io.on('connection', (socket) => {
    const userId = socket.user.id;
    socket.join(`user:${userId}`);
    onlineCounts.set(userId, (onlineCounts.get(userId) || 0) + 1);
    socket.emit('session:ready', { userId });
    broadcastPresence();
    socket.on('typing', (payload = {}) => {
      const conversationId = Number(payload?.conversationId);
      if (!Number.isSafeInteger(conversationId) || conversationId <= 0) return;
      const member = db.prepare(
        'SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
      ).get(conversationId, userId);
      if (!member) return;
      const others = db.prepare(
        'SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id <> ?'
      ).all(conversationId, userId);
      for (const row of others) {
        io.to(`user:${row.user_id}`).emit('conversation:typing', {
          conversationId, userId, typing: Boolean(payload?.typing)
        });
      }
    });
    socket.on('disconnect', () => {
      const count = Math.max((onlineCounts.get(userId) || 1) - 1, 0);
      if (count === 0) onlineCounts.delete(userId); else onlineCounts.set(userId, count);
      broadcastPresence();
    });
  });

  return { app, server, io, db };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '0.0.0.0';
  const { server, db } = createApplication();
  server.listen(port, host, () => {
    console.log(`云屿已启动：http://localhost:${port}`);
    console.log(`局域网访问：http://<本机局域网IP>:${port}`);
  });
  const shutdown = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createApplication };
