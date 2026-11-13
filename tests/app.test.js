const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApplication } = require('../server');

class TestClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.cookie = '';
  }

  async request(route, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set('X-Requested-With', 'XMLHttpRequest');
    if (this.cookie) headers.set('Cookie', this.cookie);
    let body = options.body;
    if (body && !(body instanceof FormData) && typeof body !== 'string') {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify(body);
    }
    const response = await fetch(`${this.baseUrl}/api${route}`, { ...options, headers, body });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    const text = await response.text();
    let data = {};
    if ((response.headers.get('content-type') || '').includes('application/json')) data = JSON.parse(text);
    return { status: response.status, data, text, headers: response.headers };
  }

  register(username, password = 'Passw0rd!') {
    return this.request('/auth/register', { method: 'POST', body: { username, password } });
  }
}

test('云屿全栈核心流程与权限边界', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yunyu-test-'));
  const { server, io, db } = createApplication({ dataDir: tempRoot, seed: false });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const alice = new TestClient(baseUrl);
  const bob = new TestClient(baseUrl);
  const charlie = new TestClient(baseUrl);
  let privateConversationId;
  let groupConversationId;

  t.after(async () => {
    io.close();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    const resolved = fs.realpathSync(tempRoot);
    const tempParent = fs.realpathSync(os.tmpdir());
    if (path.dirname(resolved) === tempParent && path.basename(resolved).startsWith('yunyu-test-')) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  });

  await t.test('健康检查、静态页面和未登录拦截', async () => {
    const health = await alice.request('/health');
    assert.equal(health.status, 200);
    assert.equal(health.data.ok, true);
    const page = await fetch(baseUrl);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /云屿/);
    const protectedResult = await alice.request('/bootstrap');
    assert.equal(protectedResult.status, 401);
  });

  await t.test('注册校验、唯一用户名、密码哈希和持久会话', async () => {
    assert.equal((await alice.register('alice_01', 'weak')).status, 400);
    assert.equal((await alice.register('alice_01')).status, 201);
    assert.equal((await bob.register('bob_01')).status, 201);
    assert.equal((await charlie.register('charlie_01')).status, 201);
    const duplicate = await new TestClient(baseUrl).register('ALICE_01');
    assert.equal(duplicate.status, 409);
    const wrongLogin = await new TestClient(baseUrl).request('/auth/login', { method: 'POST', body: { username: 'alice_01', password: 'Wrong123!' } });
    assert.equal(wrongLogin.status, 401);
    const bootstrap = await alice.request('/bootstrap');
    assert.equal(bootstrap.status, 200);
    assert.equal(bootstrap.data.user.username, 'alice_01');
    const stored = db.prepare('SELECT password_hash FROM users WHERE username = ?').get('alice_01');
    assert.notEqual(stored.password_hash, 'Passw0rd!');
    assert.match(stored.password_hash, /^\$2[aby]\$/);
    const rawToken = alice.cookie.split('=')[1];
    const sessions = db.prepare('SELECT token_hash FROM sessions').all();
    assert.ok(sessions.length >= 3);
    assert.ok(sessions.every((session) => session.token_hash !== rawToken));
  });

  await t.test('跨站与缺少安全校验头的写请求会被阻止', async () => {
    const noHeader = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'alice_01', password: 'Passw0rd!' })
    });
    assert.equal(noHeader.status, 403);
    const evilOrigin = await alice.request('/conversations/private', {
      method: 'POST', headers: { Origin: 'https://evil.example' }, body: { userId: 2 }
    });
    assert.equal(evilOrigin.status, 403);
  });

  await t.test('好友请求、接受请求和私聊权限', async () => {
    const sent = await alice.request('/friends/requests', { method: 'POST', body: { username: 'bob_01' } });
    assert.equal(sent.status, 201);
    const bobRequests = await bob.request('/friends');
    assert.equal(bobRequests.data.requests.incoming.length, 1);
    const requestId = bobRequests.data.requests.incoming[0].id;
    assert.equal((await bob.request(`/friends/requests/${requestId}/accept`, { method: 'POST' })).status, 200);
    assert.equal((await alice.request('/friends')).data.friends.length, 1);
    const stranger = await alice.request('/conversations/private', { method: 'POST', body: { userId: 3 } });
    assert.equal(stranger.status, 403);
    const created = await alice.request('/conversations/private', { method: 'POST', body: { userId: 2 } });
    assert.equal(created.status, 201);
    privateConversationId = created.data.conversation.id;
  });

  await t.test('私聊消息、已读和第三方隔离', async () => {
    const body = '你好 <script>alert(1)</script>';
    const sent = await alice.request(`/conversations/${privateConversationId}/messages`, { method: 'POST', body: { body } });
    assert.equal(sent.status, 201);
    assert.equal(sent.data.message.body, body);
    const bobMessages = await bob.request(`/conversations/${privateConversationId}/messages`);
    assert.equal(bobMessages.status, 200);
    assert.equal(bobMessages.data.messages.at(-1).body, body);
    const outsider = await charlie.request(`/conversations/${privateConversationId}/messages`);
    assert.equal(outsider.status, 404);
    assert.equal((await bob.request(`/conversations/${privateConversationId}/read`, { method: 'POST' })).status, 200);
  });

  await t.test('群聊创建、群消息和成员管理权限', async () => {
    const invalid = await alice.request('/conversations/group', { method: 'POST', body: { name: '测试群', memberIds: [2, 3] } });
    assert.equal(invalid.status, 400);
    const created = await alice.request('/conversations/group', { method: 'POST', body: { name: '周末游戏搭子', memberIds: [2] } });
    assert.equal(created.status, 201);
    groupConversationId = created.data.conversation.id;
    assert.equal((await alice.request(`/conversations/${groupConversationId}/messages`, { method: 'POST', body: { body: '周末见' } })).status, 201);
    assert.equal((await bob.request(`/conversations/${groupConversationId}/messages`)).status, 200);
    assert.equal((await charlie.request(`/conversations/${groupConversationId}/messages`)).status, 404);
    assert.equal((await bob.request(`/conversations/${groupConversationId}/members`, { method: 'POST', body: { userId: 3 } })).status, 403);
  });

  await t.test('个人文件跨会话下载、删除和越权拦截', async () => {
    const form = new FormData();
    form.append('file', new Blob(['跨设备文件内容'], { type: 'text/plain' }), '跨设备.txt');
    const uploaded = await alice.request('/files', { method: 'POST', body: form });
    assert.equal(uploaded.status, 201);
    const fileId = uploaded.data.fileId;
    const download = await alice.request(`/files/${fileId}/download`);
    assert.equal(download.status, 200);
    assert.equal(download.text, '跨设备文件内容');
    assert.equal((await bob.request(`/files/${fileId}/download`)).status, 403);
    assert.equal((await bob.request(`/files/${fileId}`, { method: 'DELETE' })).status, 404);
    assert.equal((await alice.request(`/files/${fileId}`, { method: 'DELETE' })).status, 200);
    assert.equal((await alice.request(`/files/${fileId}/download`)).status, 404);
  });

  await t.test('聊天附件仅会话成员可下载且不能单独删除', async () => {
    const form = new FormData();
    form.append('file', new Blob(['聊天附件内容'], { type: 'text/plain' }), '攻略.txt');
    form.append('body', '这份攻略给你');
    const sent = await alice.request(`/conversations/${privateConversationId}/files`, { method: 'POST', body: form });
    assert.equal(sent.status, 201);
    const attachment = sent.data.message.attachment;
    assert.equal(attachment.original_name, '攻略.txt');
    const bobDownload = await bob.request(`/files/${attachment.id}/download`);
    assert.equal(bobDownload.status, 200);
    assert.equal(bobDownload.text, '聊天附件内容');
    assert.equal((await charlie.request(`/files/${attachment.id}/download`)).status, 403);
    assert.equal((await alice.request(`/files/${attachment.id}`, { method: 'DELETE' })).status, 409);
  });

  await t.test('资料编辑接口与校验', async () => {
    assert.equal((await alice.request('/me', { method: 'PATCH', body: { display_name: 'A', avatar_color: '#4f7568' } })).status, 400);
    assert.equal((await alice.request('/me', { method: 'PATCH', body: { display_name: '爱丽丝', avatar_color: '#ff0000' } })).status, 400);
    const updated = await alice.request('/me', { method: 'PATCH', body: { display_name: '爱丽丝', avatar_color: '#657b9b' } });
    assert.equal(updated.status, 200);
    assert.equal(updated.data.user.display_name, '爱丽丝');
    assert.equal(updated.data.user.avatar_color, '#657b9b');
    const bootstrap = await bob.request('/bootstrap');
    assert.equal(bootstrap.data.friends.find((friend) => friend.username === 'alice_01').display_name, '爱丽丝');
  });

  await t.test('私聊已读回执', async () => {
    const sent = await alice.request(`/conversations/${privateConversationId}/messages`, { method: 'POST', body: { body: '看看已读状态' } });
    assert.equal(sent.status, 201);
    const beforeRead = (await alice.request('/conversations')).data.conversations
      .find((conversation) => conversation.id === privateConversationId);
    assert.ok(beforeRead.peer_last_read_message_id < sent.data.message.id);
    assert.equal((await bob.request(`/conversations/${privateConversationId}/read`, { method: 'POST' })).status, 200);
    const afterRead = (await alice.request('/conversations')).data.conversations
      .find((conversation) => conversation.id === privateConversationId);
    assert.ok(afterRead.peer_last_read_message_id >= sent.data.message.id);
  });

  await t.test('消息撤回权限与附件清理', async () => {
    const messages = (await bob.request(`/conversations/${privateConversationId}/messages`)).data.messages;
    const aliceMessage = messages.find((message) => message.sender.username === 'alice_01');
    const attachmentMessage = messages.find((message) => message.attachment);
    const bobSent = await bob.request(`/conversations/${privateConversationId}/messages`, { method: 'POST', body: { body: '稍后回复你' } });
    assert.equal((await bob.request(`/conversations/${privateConversationId}/messages/${aliceMessage.id}`, { method: 'DELETE' })).status, 403);
    assert.equal((await alice.request(`/conversations/${privateConversationId}/messages/${attachmentMessage.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await bob.request(`/files/${attachmentMessage.attachment.id}/download`)).status, 404);
    assert.equal((await bob.request(`/conversations/${privateConversationId}/messages/${bobSent.data.message.id}`, { method: 'DELETE' })).status, 200);
    const after = (await alice.request(`/conversations/${privateConversationId}/messages`)).data.messages;
    assert.ok(after.every((message) => message.id !== bobSent.data.message.id && message.id !== attachmentMessage.id));
    assert.equal((await alice.request(`/conversations/${privateConversationId}/messages/999999`, { method: 'DELETE' })).status, 404);
  });

  await t.test('群聊移除成员、群主转让与解散', async () => {
    await alice.request('/friends/requests', { method: 'POST', body: { username: 'charlie_01' } });
    const charlieId = (await charlie.request('/auth/status')).data.user.id;
    const charlieRequests = (await charlie.request('/friends')).data.requests.incoming;
    assert.equal((await charlie.request(`/friends/requests/${charlieRequests[0].id}/accept`, { method: 'POST' })).status, 200);
    assert.equal((await alice.request(`/conversations/${groupConversationId}/members`, { method: 'POST', body: { userId: charlieId } })).status, 201);
    assert.equal((await alice.request(`/conversations/${groupConversationId}/members/${charlieId}`, { method: 'DELETE' })).status, 200);
    assert.equal((await charlie.request(`/conversations/${groupConversationId}/messages`)).status, 404);
    assert.equal((await charlie.request(`/conversations/${groupConversationId}/members`, { method: 'POST', body: { userId: charlieId } })).status, 404);
    assert.equal((await alice.request(`/conversations/${groupConversationId}/members/1`, { method: 'DELETE' })).status, 400);
    assert.equal((await alice.request(`/conversations/${groupConversationId}/leave`, { method: 'POST' })).status, 200);
    const bobId = (await bob.request('/auth/status')).data.user.id;
    const inherited = (await bob.request('/conversations')).data.conversations
      .find((conversation) => conversation.id === groupConversationId);
    assert.ok(inherited);
    assert.equal(inherited.owner_id, bobId);
    assert.equal((await bob.request(`/conversations/${groupConversationId}/leave`, { method: 'POST' })).status, 200);
    assert.equal((await bob.request(`/conversations/${groupConversationId}/messages`)).status, 404);
  });

  await t.test('云游戏直连官方网页版，返回真实可启动地址', async () => {
    const games = await alice.request('/cloud/games');
    assert.equal(games.status, 200);
    assert.equal(games.data.games.length, 4);
    const genshin = games.data.games.find((game) => game.id === 'genshin');
    assert.equal(genshin.name, '原神');
    assert.equal(genshin.cloudName, '云·原神');
    assert.equal(genshin.officialUrl, 'https://ys.mihoyo.com/cloud/');
    assert.equal(genshin.officialHost, 'ys.mihoyo.com');
    assert.ok(games.data.games.some((game) => game.name === '鸣潮'));
    assert.ok(games.data.games.every((game) => game.configured === true));
    assert.ok(games.data.games.every((game) => game.source === 'official'));
    assert.ok(games.data.games.every((game) => game.mode === 'external'));
    assert.ok(games.data.games.every((game) => game.ssoConfigured === false));
    assert.ok(games.data.games.every((game) => game.requiresGameLogin === true));
    assert.match(games.data.notice, /不等于游戏免登/);

    const launch = await alice.request('/cloud/games/genshin/launch', { method: 'POST' });
    assert.equal(launch.status, 200);
    assert.equal(launch.data.launchUrl, 'https://ys.mihoyo.com/cloud/');
    assert.equal(launch.data.officialHost, 'ys.mihoyo.com');
    assert.equal(launch.data.mode, 'external');
    assert.equal(launch.data.requiresGameLogin, true);
    assert.equal(launch.data.singleSignOn, false);
    assert.match(launch.data.message, /米哈游通行证/);
    assert.equal((await alice.request('/cloud/games/unknown/launch', { method: 'POST' })).status, 404);
  });

  await t.test('自建服务可覆盖入口，列表不泄露地址并校验配置', async () => {
    const keys = ['CLOUD_GENSHIN_URL', 'CLOUD_GENSHIN_EMBED', 'CLOUD_GENSHIN_SSO'];
    const previous = keys.map((key) => process.env[key]);
    const restore = () => keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    try {
      process.env.CLOUD_GENSHIN_URL = 'https://cloud.example.com/play';
      process.env.CLOUD_GENSHIN_EMBED = '1';
      process.env.CLOUD_GENSHIN_SSO = '1';
      const games = await alice.request('/cloud/games');
      const genshin = games.data.games.find((game) => game.id === 'genshin');
      assert.equal(genshin.source, 'custom');
      assert.equal(genshin.launchUrl, null, '列表不应暴露自建服务地址');
      assert.equal(genshin.mode, 'iframe');
      assert.equal(genshin.ssoConfigured, true);
      assert.equal(genshin.requiresGameLogin, false);
      const launch = await alice.request('/cloud/games/genshin/launch', { method: 'POST' });
      assert.equal(launch.status, 200);
      assert.equal(launch.data.launchUrl, 'https://cloud.example.com/play');
      assert.equal(launch.data.mode, 'iframe');
      assert.equal(launch.data.singleSignOn, true);

      process.env.CLOUD_GENSHIN_URL = 'javascript:alert(1)';
      const bad = await alice.request('/cloud/games/genshin/launch', { method: 'POST' });
      assert.equal(bad.status, 409);
      assert.match(bad.data.error, /配置无效/);
    } finally {
      restore();
    }
  });
});

test('朋友圈：图文动态、可见范围、点赞评论与删除', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yunyu-moments-test-'));
  const { server, io, db } = createApplication({ dataDir: tempRoot, seed: false });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const alice = new TestClient(baseUrl);
  const bob = new TestClient(baseUrl);
  const charlie = new TestClient(baseUrl);
  const dave = new TestClient(baseUrl);
  let momentId;
  let imageMomentId;
  let imageRoute;

  t.after(async () => {
    io.close();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    const resolved = fs.realpathSync(tempRoot);
    if (path.dirname(resolved) === fs.realpathSync(os.tmpdir()) && path.basename(resolved).startsWith('yunyu-moments-test-')) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  });

  const makeFriends = async (from, to, targetUsername) => {
    assert.equal((await from.request('/friends/requests', { method: 'POST', body: { username: targetUsername } })).status, 201);
    const incoming = (await to.request('/friends')).data.requests.incoming;
    assert.equal((await to.request(`/friends/requests/${incoming[0].id}/accept`, { method: 'POST' })).status, 200);
  };

  assert.equal((await alice.register('m_alice')).status, 201);
  assert.equal((await bob.register('m_bob')).status, 201);
  assert.equal((await charlie.register('m_charlie')).status, 201);
  assert.equal((await dave.register('m_dave')).status, 201);
  await makeFriends(alice, bob, 'm_bob');
  await makeFriends(alice, charlie, 'm_charlie');
  const bobId = (await bob.request('/auth/status')).data.user.id;
  const aliceId = (await alice.request('/auth/status')).data.user.id;

  await t.test('发布校验与好友 / 私密 / 公开可见范围', async () => {
    assert.equal((await alice.request('/moments', { method: 'POST', body: { body: '', visibility: 'friends' } })).status, 400);
    assert.equal((await alice.request('/moments', { method: 'POST', body: { body: 'x'.repeat(2001) } })).status, 400);
    assert.equal((await alice.request('/moments', { method: 'POST', body: { body: '正常', visibility: 'everyone' } })).status, 400);
    const created = await alice.request('/moments', { method: 'POST', body: { body: '今天天气真好', visibility: 'friends' } });
    assert.equal(created.status, 201);
    momentId = created.data.moment.id;
    assert.equal(created.data.moment.author.username, 'm_alice');
    assert.ok((await bob.request('/moments')).data.moments.some((moment) => moment.id === momentId));
    assert.ok((await charlie.request('/moments')).data.moments.some((moment) => moment.id === momentId));
    assert.ok(!(await dave.request('/moments')).data.moments.some((moment) => moment.id === momentId));

    const secret = await alice.request('/moments', { method: 'POST', body: { body: '私人日记', visibility: 'private' } });
    assert.equal(secret.status, 201);
    assert.ok((await alice.request('/moments')).data.moments.some((moment) => moment.id === secret.data.moment.id));
    assert.ok(!(await bob.request('/moments')).data.moments.some((moment) => moment.id === secret.data.moment.id));

    const open = await alice.request('/moments', { method: 'POST', body: { body: '社区公告', visibility: 'public' } });
    assert.ok((await dave.request('/moments')).data.moments.some((moment) => moment.id === open.data.moment.id));
    assert.equal((await dave.request(`/moments/${momentId}/like`, { method: 'POST' })).status, 404);
    assert.equal((await dave.request(`/moments/${momentId}/comments`, { method: 'POST', body: { body: '你好' } })).status, 404);
  });

  await t.test('九宫格图片上传、类型校验与按动态鉴权', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');
    const form = new FormData();
    form.append('body', '附上一张图');
    form.append('visibility', 'friends');
    form.append('images', new Blob([png], { type: 'image/png' }), 'a.png');
    form.append('images', new Blob([png], { type: 'image/png' }), 'b.png');
    const created = await alice.request('/moments', { method: 'POST', body: form });
    assert.equal(created.status, 201);
    assert.equal(created.data.moment.images.length, 2);
    imageMomentId = created.data.moment.id;
    imageRoute = created.data.moment.images[0].url.replace('/api', '');
    assert.equal((await alice.request(imageRoute)).status, 200);
    assert.equal((await bob.request(imageRoute)).status, 200);
    assert.equal((await dave.request(imageRoute)).status, 404);

    const badType = new FormData();
    badType.append('body', '伪装图片');
    badType.append('images', new Blob(['<script>alert(1)</script>'], { type: 'text/html' }), 'fake.html');
    assert.equal((await alice.request('/moments', { method: 'POST', body: badType })).status, 400);
  });

  await t.test('点赞去重与取消、评论回复及删除权限', async () => {
    const liked = await bob.request(`/moments/${momentId}/like`, { method: 'POST' });
    assert.equal(liked.status, 200);
    assert.equal(liked.data.liked, true);
    assert.equal(liked.data.likes.length, 1);
    assert.equal((await bob.request(`/moments/${momentId}/like`, { method: 'POST' })).data.likes.length, 1);
    const aliceView = (await alice.request('/moments')).data.moments.find((moment) => moment.id === momentId);
    const bobView = (await bob.request('/moments')).data.moments.find((moment) => moment.id === momentId);
    assert.equal(aliceView.liked, false);
    assert.equal(bobView.liked, true);
    assert.equal(bobView.likes[0].id, bobId);
    const unliked = await bob.request(`/moments/${momentId}/like`, { method: 'DELETE' });
    assert.equal(unliked.data.liked, false);
    assert.equal(unliked.data.likes.length, 0);

    const comment = await bob.request(`/moments/${momentId}/comments`, { method: 'POST', body: { body: '好天气！' } });
    assert.equal(comment.status, 201);
    assert.equal(comment.data.comment.author.id, bobId);
    assert.equal((await bob.request(`/moments/${momentId}/comments`, { method: 'POST', body: { body: '' } })).status, 400);
    assert.equal((await bob.request(`/moments/${momentId}/comments`, { method: 'POST', body: { body: '回复', replyToUserId: 99999 } })).status, 400);
    const reply = await alice.request(`/moments/${momentId}/comments`, {
      method: 'POST', body: { body: '是呀，一起出去走走', replyToUserId: bobId }
    });
    assert.equal(reply.status, 201);
    assert.equal(reply.data.comment.reply_to.id, bobId);
    assert.equal((await charlie.request(`/moments/${momentId}/comments/${comment.data.comment.id}`, { method: 'DELETE' })).status, 403);
    assert.equal((await bob.request(`/moments/${momentId}/comments/${comment.data.comment.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await alice.request(`/moments/${momentId}/comments/${comment.data.comment.id}`, { method: 'DELETE' })).status, 404);
  });

  await t.test('互动消息只汇总别人对我动态的点赞与评论', async () => {
    await bob.request(`/moments/${momentId}/like`, { method: 'POST' });
    await bob.request(`/moments/${momentId}/comments`, { method: 'POST', body: { body: '点赞之外再留个言' } });
    const response = await alice.request('/moments/notifications');
    assert.equal(response.status, 200);
    const notices = response.data.notifications;
    assert.ok(notices.some((notice) => notice.type === 'like' && notice.actor_id === bobId));
    assert.ok(notices.some((notice) => notice.type === 'comment' && notice.body === '点赞之外再留个言'));
    assert.ok(notices.every((notice) => notice.actor_id !== aliceId));
    assert.equal(response.data.latestAt, notices[0].created_at);
    assert.equal((await bob.request('/moments/notifications')).data.notifications.length, 0);
  });

  await t.test('删除权限、级联清理与分页', async () => {
    assert.equal((await bob.request(`/moments/${imageMomentId}`, { method: 'DELETE' })).status, 404);
    const page = await alice.request('/moments?limit=1');
    assert.equal(page.data.moments.length, 1);
    assert.equal(page.data.hasMore, true);
    const older = await alice.request(`/moments?limit=10&before=${page.data.moments[0].id}`);
    assert.ok(older.data.moments.every((moment) => moment.id < page.data.moments[0].id));

    assert.equal((await alice.request(`/moments/${imageMomentId}`, { method: 'DELETE' })).status, 200);
    assert.equal((await alice.request(imageRoute)).status, 404);
    assert.ok(!(await bob.request('/moments')).data.moments.some((moment) => moment.id === imageMomentId));
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM moment_media WHERE moment_id = ?').get(imageMomentId).count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM moment_likes WHERE moment_id = ?').get(imageMomentId).count, 0);
  });

  await t.test('解除好友关系后不再看到对方动态', async () => {
    db.prepare('DELETE FROM friendships WHERE (user_id = 1 AND friend_id = ?) OR (user_id = ? AND friend_id = 1)').run(bobId, bobId);
    assert.ok(!(await bob.request('/moments')).data.moments.some((moment) => moment.id === momentId));
    assert.equal((await bob.request(`/moments/${momentId}/like`, { method: 'POST' })).status, 404);
  });
});

test('生产模式默认空数据并使用外部持久目录', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yunyu-production-test-'));
  const previous = {
    nodeEnv: process.env.NODE_ENV,
    seedDemo: process.env.SEED_DEMO,
    dataDir: process.env.DATA_DIR
  };
  let context;
  try {
    process.env.NODE_ENV = 'production';
    process.env.DATA_DIR = tempRoot;
    delete process.env.SEED_DEMO;
    context = createApplication();
    const { server, db } = context;
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 0);
    assert.equal(db.name, path.join(tempRoot, 'yunyu.db'));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/health`);
    assert.equal(response.status, 200);
  } finally {
    if (context) {
      context.io.close();
      await new Promise((resolve) => context.server.close(resolve));
      context.db.close();
    }
    if (previous.nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous.nodeEnv;
    if (previous.seedDemo === undefined) delete process.env.SEED_DEMO; else process.env.SEED_DEMO = previous.seedDemo;
    if (previous.dataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previous.dataDir;
    const resolved = fs.realpathSync(tempRoot);
    if (path.dirname(resolved) === fs.realpathSync(os.tmpdir()) && path.basename(resolved).startsWith('yunyu-production-test-')) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
});
