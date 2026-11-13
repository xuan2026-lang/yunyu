// 云游戏大厅的游戏元数据。
//
// 这里内置的是各游戏厂商「官方云游戏网页版」的公开入口：浏览器打开后由厂商自己的
// 页面完成登录与串流，进度与官方客户端互通。云屿不代理游戏流量、不接触游戏账号，
// 也不宣称能用网站账号代替游戏账号登录。
//
// 官方页面均设置了 X-Frame-Options: DENY / CSP，禁止被第三方站点 iframe 嵌入，
// 因此官方入口一律以新标签页（external）打开。只有部署者自己拥有并配置的自建
// 服务，才允许用 *_EMBED=1 开启站内嵌入。

const BROWSER_HINT = '推荐使用最新版 Edge / Chrome / Safari；部分手机自带浏览器与 App 内置浏览器可能无法启动或无法全屏，进入游戏后按 F11 可全屏。';

const GAMES = [
  {
    id: 'genshin',
    name: '原神',
    cloudName: '云·原神',
    subtitle: '提瓦特，随时启程',
    description: '在七国之间穿行，收集元素之力，解开提瓦特大陆上的谜题与故事。',
    category: '开放世界',
    tags: ['开放世界', '元素战斗', '探索'],
    provider: '米哈游官方',
    publisher: '米哈游 / HoYoverse',
    account: '米哈游通行证',
    officialUrl: 'https://ys.mihoyo.com/cloud/',
    officialHost: 'ys.mihoyo.com',
    freeTime: '首次登录有免费时长，每日登录可继续领取，也可购买畅玩卡；时长规则以官方页面为准。',
    envKey: 'CLOUD_GENSHIN_URL',
    platform: '浏览器 / 手机 / 平板 / 电脑',
    theme: 'sage',
    mark: '原',
    featured: true
  },
  {
    id: 'wuthering-waves',
    name: '鸣潮',
    cloudName: '云·鸣潮',
    subtitle: '循声而行，探索新世界',
    description: '循着声骸的共鸣探索新世界，在高自由度的战斗与移动中找到自己的答案。',
    category: '开放世界',
    tags: ['开放世界', '动作', '声骸'],
    provider: '库洛官方',
    publisher: '库洛游戏',
    account: '库洛通行证（仅官服）',
    officialUrl: 'https://mc.kurogames.com/cloud/',
    officialHost: 'mc.kurogames.com',
    freeTime: '首次登录与版本更新会赠送免费时长，也可购买畅玩卡；时长规则以官方页面为准。',
    envKey: 'CLOUD_WUTHERING_WAVES_URL',
    platform: '浏览器 / 手机 / 平板 / 电脑',
    theme: 'ocean',
    mark: '鸣'
  },
  {
    id: 'honkai-star-rail',
    name: '崩坏：星穹铁道',
    cloudName: '云·星穹铁道',
    subtitle: '愿此行，终抵群星',
    description: '登上星穹列车，沿着银河航线停靠不同世界，在回合制战斗里推进旅程。',
    category: '回合制',
    tags: ['回合制', '剧情', '银河'],
    provider: '米哈游官方',
    publisher: '米哈游 / HoYoverse',
    account: '米哈游通行证',
    officialUrl: 'https://sr.mihoyo.com/cloud/',
    officialHost: 'sr.mihoyo.com',
    freeTime: '每日登录可领取免费时长，也可购买畅玩卡；时长规则以官方页面为准。',
    envKey: 'CLOUD_STAR_RAIL_URL',
    platform: '浏览器 / 手机 / 平板 / 电脑',
    theme: 'sand',
    mark: '星'
  },
  {
    id: 'zenless-zone-zero',
    name: '绝区零',
    cloudName: '云·绝区零',
    subtitle: '在新艾利都见面',
    description: '在街区与空洞之间穿梭，用高速连招与队伍配合清理战场。',
    category: '动作',
    tags: ['动作', '都市', '连招'],
    provider: '米哈游官方',
    publisher: '米哈游 / HoYoverse',
    account: '米哈游通行证',
    officialUrl: 'https://zzz.mihoyo.com/cloud-feat/',
    officialHost: 'zzz.mihoyo.com',
    freeTime: '登录赠送免费时长并可按日领取，也可购买畅玩卡；时长规则以官方页面为准。',
    envKey: 'CLOUD_ZZZ_URL',
    platform: '浏览器 / 手机 / 平板 / 电脑',
    theme: 'graphite',
    mark: '绝'
  }
];

// 只允许 https，自建服务在本机调试时允许 http://localhost。
function safeUrl(raw) {
  try {
    const parsed = new URL(String(raw || '').trim());
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) return null;
    if (parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function describe(game) {
  const custom = (process.env[game.envKey] || '').trim();
  const source = custom ? 'custom' : 'official';
  const launchUrl = safeUrl(custom || game.officialUrl);
  const envPrefix = game.envKey.replace(/_URL$/, '');
  // SSO 与站内嵌入只对自建/已授权服务有意义；官方入口永远需要用户自己登录游戏账号。
  const ssoConfigured = source === 'custom' && process.env[`${envPrefix}_SSO`] === '1';
  const embedAllowed = source === 'custom' && process.env[`${envPrefix}_EMBED`] === '1' && Boolean(launchUrl);
  return {
    ...game,
    configured: Boolean(launchUrl),
    source,
    launchUrl,
    mode: embedAllowed ? 'iframe' : 'external',
    ssoConfigured,
    requiresGameLogin: source === 'official' || !ssoConfigured,
    browserHint: BROWSER_HINT
  };
}

// 列表接口不泄露自建服务地址，官方入口则公开展示域名供用户核对，避免钓鱼。
function listGames() {
  return GAMES.map((game) => {
    const item = describe(game);
    return {
      id: item.id,
      name: item.name,
      cloudName: item.cloudName,
      subtitle: item.subtitle,
      description: item.description,
      category: item.category,
      tags: item.tags,
      provider: item.provider,
      publisher: item.publisher,
      account: item.account,
      officialUrl: item.officialUrl,
      officialHost: item.officialHost,
      freeTime: item.freeTime,
      browserHint: item.browserHint,
      platform: item.platform,
      theme: item.theme,
      mark: item.mark,
      featured: Boolean(item.featured),
      configured: item.configured,
      source: item.source,
      launchUrl: item.source === 'official' ? item.officialUrl : null,
      mode: item.mode,
      ssoConfigured: item.ssoConfigured,
      requiresGameLogin: item.requiresGameLogin
    };
  });
}

function getGame(id) {
  const game = GAMES.find((item) => item.id === id);
  return game ? describe(game) : null;
}

module.exports = { listGames, getGame };
