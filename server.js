const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;

// ==================== 数据文件路径 ====================
const DATA_DIR = path.join(__dirname, 'data');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const TEA_DATA_FILE = path.join(DATA_DIR, 'tea_data.json');
const TOKENS_FILE = path.join(DATA_DIR, 'tokens.json');

// ==================== 工具函数 ====================
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJSON(file, defaultVal = {}) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) { console.error('Read error:', file, e.message); }
  return defaultVal;
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

function hashPassword(pwd) {
  return crypto.createHash('sha256').update('tea_sync_2026_salt' + pwd + 'tea_sync_2026_salt').digest('hex');
}

// ==================== 初始化管理员账号 ====================
function initAccounts() {
  ensureDataDir();
  const accounts = readJSON(ACCOUNTS_FILE, {});
  if (!accounts['lxsnfuhe@163.com']) {
    accounts['lxsnfuhe@163.com'] = {
      password: hashPassword('000208'),
      role: 'admin',
      trialCounts: {},
      createdAt: new Date().toISOString(),
      failedAttempts: 0,
      lockedUntil: null
    };
    writeJSON(ACCOUNTS_FILE, accounts);
    console.log('Admin account initialized: lxsnfuhe@163.com');
  }
}

// ==================== Token 管理 ====================
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function createSession(userEmail, rememberMe) {
  const tokens = readJSON(TOKENS_FILE, {});
  const token = generateToken();
  tokens[token] = {
    user: userEmail,
    createdAt: Date.now(),
    expiresAt: rememberMe ? Date.now() + 7 * 24 * 60 * 60 * 1000 : Date.now() + 24 * 60 * 60 * 1000
  };
  writeJSON(TOKENS_FILE, tokens);
  return token;
}

function validateToken(token) {
  if (!token) return null;
  const tokens = readJSON(TOKENS_FILE, {});
  const session = tokens[token];
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    delete tokens[token];
    writeJSON(TOKENS_FILE, tokens);
    return null;
  }
  return session.user;
}

// 清理过期 token
setInterval(() => {
  const tokens = readJSON(TOKENS_FILE, {});
  const now = Date.now();
  let changed = false;
  for (const t in tokens) {
    if (now > tokens[t].expiresAt) { delete tokens[t]; changed = true; }
  }
  if (changed) writeJSON(TOKENS_FILE, tokens);
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
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
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

// ==================== 路由 ====================
function handleAPI(req, res, pathname) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // 登录
  if (pathname === '/api/login' && req.method === 'POST') {
    parseBody(req, (body) => {
      const { user, password, rememberMe } = body;
      if (!user || !password) return sendJSON(res, 400, { error: '请输入账号和密码' });
      const accounts = readJSON(ACCOUNTS_FILE, {});
      const acct = accounts[user];
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
          writeJSON(ACCOUNTS_FILE, accounts);
          return sendJSON(res, 423, { error: '密码错误次数过多，账号已锁定 30 分钟' });
        }
        writeJSON(ACCOUNTS_FILE, accounts);
        return sendJSON(res, 401, { error: '密码错误，还剩 ' + (5 - acct.failedAttempts) + ' 次尝试机会' });
      }

      acct.failedAttempts = 0;
      acct.lockedUntil = null;
      writeJSON(ACCOUNTS_FILE, accounts);

      const token = createSession(user, !!rememberMe);
      sendJSON(res, 200, { token, role: acct.role, user });
    });
    return;
  }

  // 以下 API 需要登录
  const currentUser = getAuthUser(req);
  if (!currentUser) return sendJSON(res, 401, { error: '未登录或登录已过期' });

  function getAccount(user) {
    const accounts = readJSON(ACCOUNTS_FILE, {});
    return accounts[user] || null;
  }

  function isAdmin() {
    const acct = getAccount(currentUser);
    return acct && acct.role === 'admin';
  }

  // 获取当前用户信息
  if (pathname === '/api/me' && req.method === 'GET') {
    const acct = getAccount(currentUser);
    if (!acct) return sendJSON(res, 404, { error: '账号不存在' });
    sendJSON(res, 200, { user: currentUser, role: acct.role, trialCounts: acct.trialCounts || {} });
    return;
  }

  // 获取茶叶数据
  if (pathname === '/api/data' && req.method === 'GET') {
    const allData = readJSON(TEA_DATA_FILE, {});
    sendJSON(res, 200, allData[currentUser] || {});
    return;
  }

  // 保存茶叶数据
  if (pathname === '/api/save' && req.method === 'POST') {
    parseBody(req, (body) => {
      if (!body.data || typeof body.data !== 'object') return sendJSON(res, 400, { error: '数据格式错误' });
      const allData = readJSON(TEA_DATA_FILE, {});
      allData[currentUser] = body.data;
      writeJSON(TEA_DATA_FILE, allData);
      sendJSON(res, 200, { success: true, savedAt: new Date().toISOString() });
    });
    return;
  }

  // 修改密码
  if (pathname === '/api/change-password' && req.method === 'POST') {
    parseBody(req, (body) => {
      const { oldPassword, newPassword } = body;
      if (!newPassword || newPassword.length < 4) return sendJSON(res, 400, { error: '新密码至少4位' });
      const accounts = readJSON(ACCOUNTS_FILE, {});
      const acct = accounts[currentUser];
      if (acct.password !== hashPassword(oldPassword)) return sendJSON(res, 401, { error: '旧密码错误' });
      acct.password = hashPassword(newPassword);
      writeJSON(ACCOUNTS_FILE, accounts);
      sendJSON(res, 200, { success: true });
    });
    return;
  }

  // 试用计数
  if (pathname === '/api/trial-use' && req.method === 'POST') {
    parseBody(req, (body) => {
      const { action } = body;
      const accounts = readJSON(ACCOUNTS_FILE, {});
      const acct = accounts[currentUser];
      if (!acct || acct.role !== 'trial') return sendJSON(res, 200, { allowed: true, remaining: null });
      if (!acct.trialCounts) acct.trialCounts = {};
      const count = (acct.trialCounts[action] || 0) + 1;
      if (count > 3) return sendJSON(res, 200, { allowed: false, remaining: 0, message: '试用次数已用完' });
      acct.trialCounts[action] = count;
      writeJSON(ACCOUNTS_FILE, accounts);
      sendJSON(res, 200, { allowed: true, remaining: 3 - count });
    });
    return;
  }

  // 以下需要管理员权限
  if (!isAdmin()) return sendJSON(res, 403, { error: '需要管理员权限' });

  // 账号列表
  if (pathname === '/api/accounts' && req.method === 'GET') {
    const accounts = readJSON(ACCOUNTS_FILE, {});
    const list = Object.entries(accounts).map(([u, a]) => ({
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
      const accounts = readJSON(ACCOUNTS_FILE, {});
      if (accounts[user]) return sendJSON(res, 409, { error: '该账号已存在' });
      accounts[user] = {
        password: hashPassword(password), role, trialCounts: {},
        createdAt: new Date().toISOString(), failedAttempts: 0, lockedUntil: null
      };
      writeJSON(ACCOUNTS_FILE, accounts);
      sendJSON(res, 200, { success: true, user, role });
    });
    return;
  }

  // 更新账号
  if (pathname === '/api/update-account' && req.method === 'POST') {
    parseBody(req, (body) => {
      const { user, role, password, resetTrials } = body;
      const accounts = readJSON(ACCOUNTS_FILE, {});
      const acct = accounts[user];
      if (!acct) return sendJSON(res, 404, { error: '账号不存在' });
      if (user === currentUser && role && role !== 'admin') return sendJSON(res, 400, { error: '不能降级自己的管理员权限' });
      if (role) acct.role = role;
      if (password) acct.password = hashPassword(password);
      if (resetTrials) acct.trialCounts = {};
      writeJSON(ACCOUNTS_FILE, accounts);
      sendJSON(res, 200, { success: true });
    });
    return;
  }

  // 删除账号
  if (pathname === '/api/delete-account' && req.method === 'POST') {
    parseBody(req, (body) => {
      const { user } = body;
      if (user === currentUser) return sendJSON(res, 400, { error: '不能删除自己的账号' });
      const accounts = readJSON(ACCOUNTS_FILE, {});
      if (!accounts[user]) return sendJSON(res, 404, { error: '账号不存在' });
      delete accounts[user];
      writeJSON(ACCOUNTS_FILE, accounts);
      const allData = readJSON(TEA_DATA_FILE, {});
      delete allData[user];
      writeJSON(TEA_DATA_FILE, allData);
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

  // API 路由
  if (pathname.startsWith('/api/')) {
    return handleAPI(req, res, pathname);
  }

  // 静态文件
  let filePath = path.join(__dirname, 'public', pathname === '/' ? 'index.html' : pathname);
  // SPA fallback: 非文件请求返回 index.html
  if (!fs.existsSync(filePath)) {
    filePath = path.join(__dirname, 'public', 'index.html');
  }
  sendStatic(res, filePath);
});

initAccounts();
server.listen(PORT, '0.0.0.0', () => {
  console.log('Tea Inventory Cloud Sync running on http://0.0.0.0:' + PORT);
});
