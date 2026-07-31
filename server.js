const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const REPO_OWNER = 'lxsnfuhe';
const REPO_NAME = 'tea-inventory-cloud';
const DB_PATH = 'data/db.json';

// ==================== 内存数据库（从 GitHub 同步） ====================
let db = { accounts: {}, teaData: {}, tokens: {} };
let dbSha = null;

function githubAPI(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: apiPath,
      method: method,
      headers: {
        'Authorization': 'Bearer ' + GITHUB_TOKEN,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'tea-inventory-cloud'
      }
    };
    if (body) {
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(JSON.stringify(body));
    }
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400) reject(json);
          else resolve(json);
        } catch (e) { reject({ message: data, status: res.statusCode }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function loadDB() {
  if (!GITHUB_TOKEN) {
    console.log('No GITHUB_TOKEN, using local files as fallback');
    // 尝试从本地文件加载
    try {
      const localPath = path.join(__dirname, DB_PATH);
      if (fs.existsSync(localPath)) {
        db = JSON.parse(fs.readFileSync(localPath, 'utf-8'));
        console.log('Loaded from local db.json');
      }
    } catch (e) { console.log('No local db.json found, starting fresh'); }
    initDefaults();
    return;
  }
  try {
    const result = await githubAPI('GET', '/repos/' + REPO_OWNER + '/' + REPO_NAME + '/contents/' + DB_PATH);
    dbSha = result.sha;
    const content = Buffer.from(result.content, 'base64').toString('utf-8');
    db = JSON.parse(content);
    console.log('DB loaded from GitHub, sha:', dbSha);
  } catch (e) {
    if (e.status === 404) {
      console.log('No db.json in repo, will create on first save');
    } else {
      console.error('Failed to load DB from GitHub:', e.message);
    }
  }
  initDefaults();
}

function initDefaults() {
  if (!db.accounts) db.accounts = {};
  if (!db.teaData) db.teaData = {};
  if (!db.tokens) db.tokens = {};
  if (!db.accounts['lxsnfuhe@163.com']) {
    db.accounts['lxsnfuhe@163.com'] = {
      password: hashPassword('000208'),
      role: 'admin',
      trialCounts: {},
      createdAt: new Date().toISOString(),
      failedAttempts: 0,
      lockedUntil: null
    };
    console.log('Admin account initialized');
  }
}

async function saveDB() {
  if (!GITHUB_TOKEN) {
    // 保存到本地文件
    const dir = path.join(__dirname, 'data');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify(db, null, 2), 'utf-8');
    return;
  }
  const content = Buffer.from(JSON.stringify(db, null, 2)).toString('base64');
  const body = { message: 'Update data', content: content };
  if (dbSha) body.sha = dbSha;
  try {
    const result = await githubAPI('PUT', '/repos/' + REPO_OWNER + '/' + REPO_NAME + '/contents/' + DB_PATH, body);
    dbSha = result.content.sha;
    console.log('DB saved to GitHub, sha:', dbSha);
  } catch (e) {
    console.error('Failed to save DB to GitHub:', e.message);
  }
}

// ==================== 工具函数 ====================
function hashPassword(pwd) {
  return crypto.createHash('sha256').update('tea_sync_2026_salt' + pwd + 'tea_sync_2026_salt').digest('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function createSession(userEmail, rememberMe) {
  const token = generateToken();
  db.tokens[token] = {
    user: userEmail,
    createdAt: Date.now(),
    expiresAt: rememberMe ? Date.now() + 7 * 24 * 60 * 60 * 1000 : Date.now() + 24 * 60 * 60 * 1000
  };
  saveDB().catch(() => {});
  return token;
}

function validateToken(token) {
  if (!token) return null;
  const session = db.tokens[token];
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    delete db.tokens[token];
    saveDB().catch(() => {});
    return null;
  }
  return session.user;
}

// 清理过期 token
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const t in db.tokens) {
    if (now > db.tokens[t].expiresAt) { delete db.tokens[t]; changed = true; }
  }
  if (changed) saveDB().catch(() => {});
}, 60 * 60 * 1000);

// ==================== HTTP 工具 ====================
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function parseBody(req, callback) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try { callback(JSON.parse(body)); }
    catch (e) { callback({}); }
  });
}

function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function sendStatic(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';
  try {
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    res.writeHead(404);
    res.end('Not Found');
  }
}

// ==================== 认证中间件 ====================
function getAuthUser(req) {
  const token = (req.headers['authorization'] || '').replace('Bearer ', '');
  return validateToken(token);
}

function getAccount(user) {
  return db.accounts[user] || null;
}

function isAdmin(currentUser) {
  const acct = getAccount(currentUser);
  return acct && acct.role === 'admin';
}

// ==================== 路由 ====================
function handleAPI(req, res, pathname) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // 登录
  if (pathname === '/api/login' && req.method === 'POST') {
    parseBody(req, (body) => {
      const { user, password, rememberMe } = body;
      if (!user || !password) return sendJSON(res, 400, { error: '请输入账号和密码' });
      const acct = db.accounts[user];
      if (!acct) return sendJSON(res, 401, { error: '账号不存在' });

      if (acct.lockedUntil && Date.now() < acct.lockedUntil) {
        const remaining = Math.ceil((acct.lockedUntil - Date.now()) / 1000 / 60);
        return sendJSON(res, 423, { error: '账号已锁定，请 ' + remaining + ' 分钟后再试' });
      }

      if (acct.password !== hashPassword(password)) {
        acct.failedAttempts = (acct.failedAttempts || 0) + 1;
        if (acct.failedAttempts >= 5) {
          acct.lockedUntil = Date.now() + 30 * 60 * 1000;
          acct.failedAttempts = 0;
          saveDB().catch(() => {});
          return sendJSON(res, 423, { error: '密码错误次数过多，账号已锁定 30 分钟' });
        }
        saveDB().catch(() => {});
        return sendJSON(res, 401, { error: '密码错误，还剩 ' + (5 - acct.failedAttempts) + ' 次尝试机会' });
      }

      acct.failedAttempts = 0;
      acct.lockedUntil = null;
      saveDB().catch(() => {});

      const token = createSession(user, !!rememberMe);
      sendJSON(res, 200, { token, role: acct.role, user });
    });
    return;
  }

  // 以下需要登录
  const currentUser = getAuthUser(req);
  if (!currentUser) return sendJSON(res, 401, { error: '未登录或登录已过期' });

  // 获取当前用户
  if (pathname === '/api/me' && req.method === 'GET') {
    const acct = getAccount(currentUser);
    if (!acct) return sendJSON(res, 404, { error: '账号不存在' });
    sendJSON(res, 200, { user: currentUser, role: acct.role, trialCounts: acct.trialCounts || {} });
    return;
  }

  // 获取茶叶数据
  if (pathname === '/api/data' && req.method === 'GET') {
    sendJSON(res, 200, db.teaData[currentUser] || {});
    return;
  }

  // 保存茶叶数据
  if (pathname === '/api/save' && req.method === 'POST') {
    parseBody(req, (body) => {
      if (!body.data || typeof body.data !== 'object') return sendJSON(res, 400, { error: '数据格式错误' });
      db.teaData[currentUser] = body.data;
      saveDB().catch(() => {});
      sendJSON(res, 200, { success: true, savedAt: new Date().toISOString() });
    });
    return;
  }

  // 修改密码
  if (pathname === '/api/change-password' && req.method === 'POST') {
    parseBody(req, (body) => {
      const { oldPassword, newPassword } = body;
      if (!newPassword || newPassword.length < 4) return sendJSON(res, 400, { error: '新密码至少4位' });
      const acct = db.accounts[currentUser];
      if (!acct) return sendJSON(res, 404, { error: '账号不存在' });
      if (acct.password !== hashPassword(oldPassword)) return sendJSON(res, 401, { error: '旧密码错误' });
      acct.password = hashPassword(newPassword);
      saveDB().catch(() => {});
      sendJSON(res, 200, { success: true });
    });
    return;
  }

  // 试用计数
  if (pathname === '/api/trial-use' && req.method === 'POST') {
    parseBody(req, (body) => {
      const { action } = body;
      const acct = db.accounts[currentUser];
      if (!acct || acct.role !== 'trial') return sendJSON(res, 200, { allowed: true, remaining: null });
      if (!acct.trialCounts) acct.trialCounts = {};
      const count = (acct.trialCounts[action] || 0) + 1;
      if (count > 3) return sendJSON(res, 200, { allowed: false, remaining: 0, message: '试用次数已用完' });
      acct.trialCounts[action] = count;
      saveDB().catch(() => {});
      sendJSON(res, 200, { allowed: true, remaining: 3 - count });
    });
    return;
  }

  // 管理员权限检查
  if (!isAdmin(currentUser)) return sendJSON(res, 403, { error: '需要管理员权限' });

  // 账号列表
  if (pathname === '/api/accounts' && req.method === 'GET') {
    const list = Object.entries(db.accounts).map(([u, a]) => ({
      user: u, role: a.role, trialCounts: a.trialCounts || {},
      createdAt: a.createdAt || '', failedAttempts: a.failedAttempts || 0,
      lockedUntil: a.lockedUntil || null
    }));
    sendJSON(res, 200, list);
    return;
  }

  // 创建账号
  if (pathname === '/api/create-account' && req.method === 'POST') {
    parseBody(req, (body) => {
      const { user, password, role } = body;
      if (!user || !password) return sendJSON(res, 400, { error: '账号和密码不能为空' });
      if (!user.includes('@') || !user.includes('.')) return sendJSON(res, 400, { error: '请输入有效的邮箱地址' });
      if (!['admin', 'operator', 'trial', 'viewer'].includes(role)) return sendJSON(res, 400, { error: '无效的权限级别' });
      if (db.accounts[user]) return sendJSON(res, 409, { error: '该账号已存在' });
      db.accounts[user] = {
        password: hashPassword(password), role, trialCounts: {},
        createdAt: new Date().toISOString(), failedAttempts: 0, lockedUntil: null
      };
      saveDB().catch(() => {});
      sendJSON(res, 200, { success: true, user, role });
    });
    return;
  }

  // 更新账号
  if (pathname === '/api/update-account' && req.method === 'POST') {
    parseBody(req, (body) => {
      const { user, role, password, resetTrials } = body;
      const acct = db.accounts[user];
      if (!acct) return sendJSON(res, 404, { error: '账号不存在' });
      if (user === currentUser && role && role !== 'admin') return sendJSON(res, 400, { error: '不能降级自己的管理员权限' });
      if (role) acct.role = role;
      if (password) acct.password = hashPassword(password);
      if (resetTrials) acct.trialCounts = {};
      saveDB().catch(() => {});
      sendJSON(res, 200, { success: true });
    });
    return;
  }

  // 删除账号
  if (pathname === '/api/delete-account' && req.method === 'POST') {
    parseBody(req, (body) => {
      const { user } = body;
      if (user === currentUser) return sendJSON(res, 400, { error: '不能删除自己的账号' });
      if (!db.accounts[user]) return sendJSON(res, 404, { error: '账号不存在' });
      delete db.accounts[user];
      delete db.teaData[user];
      saveDB().catch(() => {});
      sendJSON(res, 200, { success: true });
    });
    return;
  }

  sendJSON(res, 404, { error: 'API not found' });
}

// ==================== 主服务器 ====================
const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  if (pathname.startsWith('/api/')) {
    return handleAPI(req, res, pathname);
  }

  let filePath = path.join(__dirname, 'public', pathname === '/' ? 'index.html' : pathname);
  if (!fs.existsSync(filePath)) {
    filePath = path.join(__dirname, 'public', 'index.html');
  }
  sendStatic(res, filePath);
});

// 启动
loadDB().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log('Tea Inventory Cloud running on port ' + PORT);
    console.log('Storage: GitHub repo ' + REPO_OWNER + '/' + REPO_NAME + '/' + DB_PATH);
  });
}).catch(err => {
  console.error('Startup failed:', err);
  process.exit(1);
});
