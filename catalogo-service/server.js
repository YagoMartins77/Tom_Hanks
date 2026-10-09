require('dotenv').config();
const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const axios = require('axios');
const mysql = require('mysql2/promise');
const multer = require('multer');
const Minio = require('minio');
const Stripe = require('stripe');

const app = express();

// ─── Stripe ───────────────────────────────────────────────────────────────────
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || '';
const stripe = Stripe(STRIPE_SECRET_KEY);
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || '';
const APP_URL = process.env.APP_URL || '';

// ─── MinIO ────────────────────────────────────────────────────────────────────
const minioClient = new Minio.Client({
  endPoint:  process.env.MINIO_ENDPOINT || 'minio',
  port:      Number(process.env.MINIO_PORT) || 9000,
  useSSL:    false,
  accessKey: process.env.MINIO_ACCESS_KEY || 'ademiro',
  secretKey: process.env.MINIO_SECRET_KEY || 'szoboslai'
});

const AVATAR_BUCKET = 'avatars';
const AUDIO_BUCKET  = 'audio-reviews';
const BANNER_BUCKET = 'banners';

// Helper para normalizar URLs de storage (resolve URLs legadas com host 'minio:9003' ou 'localhost:9003')
function normalizarStorageUrl(url) {
  if (!url) return null;
  return url.replace(/^https?:\/\/[^/]+\/(audio-reviews|avatars|banners)\//, '/api/storage/$1/');
}

async function garantirBuckets() {
  for (const bucket of [AVATAR_BUCKET, AUDIO_BUCKET, BANNER_BUCKET]) {
    try {
      const exists = await minioClient.bucketExists(bucket);
      if (!exists) {
        await minioClient.makeBucket(bucket, 'us-east-1');
        const policy = JSON.stringify({
          Version: '2012-10-17',
          Statement: [{ Effect: 'Allow', Principal: { AWS: ['*'] },
            Action: ['s3:GetObject'], Resource: [`arn:aws:s3:::${bucket}/*`] }]
        });
        await minioClient.setBucketPolicy(bucket, policy);
        console.log(`[MinIO] Bucket '${bucket}' criado e publicado.`);
      }
    } catch (e) { console.error(`[MinIO] Erro ao garantir bucket '${bucket}':`, e.message); }
  }
}
garantirBuckets();

// ─── Multer ───────────────────────────────────────────────────────────────────
const uploadImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Apenas imagens são permitidas.'));
    cb(null, true);
  }
});

const uploadAudio = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/webm'];
    if (!allowed.includes(file.mimetype)) return cb(new Error('Formato de áudio não suportado.'));
    cb(null, true);
  }
});

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc:    ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      fontSrc:     ["'self'", "https://cdnjs.cloudflare.com"],
      imgSrc:      ["'self'", "https://image.tmdb.org", "data:", "blob:", "http:", "https:"],
      mediaSrc:    ["'self'", "blob:", "http:", "https:"],
      connectSrc:  ["'self'", "http:", "https:"]
    }
  }
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: Number(process.env.DB_PORT) || 3306
});

// Auto-migração para garantir colunas necessárias sem quebrar queries
async function migrarBanco() {
  const colunasUsuarios = [
    { nome: 'premium', tipo: 'TINYINT(1) DEFAULT 0' },
    { nome: 'stripe_customer_id', tipo: 'VARCHAR(255) NULL' },
    { nome: 'avatar_url', tipo: 'VARCHAR(500) NULL' },
    { nome: 'banner_url', tipo: 'VARCHAR(500) NULL' }
  ];

  for (const c of colunasUsuarios) {
    try {
      await pool.query(`ALTER TABLE usuarios ADD COLUMN ${c.nome} ${c.tipo}`);
      console.log(`[DB] Coluna usuarios.${c.nome} adicionada.`);
    } catch (err) {
      // 1060 = ER_DUP_FIELDNAME (coluna já existe)
      if (err.errno !== 1060 && err.code !== 'ER_DUP_FIELDNAME') {
        console.warn(`[DB] Aviso ao checar usuarios.${c.nome}:`, err.message);
      }
    }
  }

  const colunasComentarios = [
    { nome: 'audio_url', tipo: 'VARCHAR(500) NULL' },
    { nome: 'fixado', tipo: 'TINYINT(1) DEFAULT 0' }
  ];

  for (const c of colunasComentarios) {
    try {
      await pool.query(`ALTER TABLE comentarios ADD COLUMN ${c.nome} ${c.tipo}`);
      console.log(`[DB] Coluna comentarios.${c.nome} adicionada.`);
    } catch (err) {
      if (err.errno !== 1060 && err.code !== 'ER_DUP_FIELDNAME') {
        console.warn(`[DB] Aviso ao checar comentarios.${c.nome}:`, err.message);
      }
    }
  }
}
migrarBanco().catch(e => console.error('[DB] Erro nas migrações:', e.message));

const sessionStore = new MySQLStore({}, pool);
app.use(session({
  key: 'session_cookie',
  secret: process.env.SESSION_SECRET || 'secret',
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 24 * 60 * 60 * 1000 }
}));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Muitas tentativas. Tente novamente mais tarde.' }
});

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth-service-yago:3001';
const LOG_SERVICE_URL = process.env.LOG_SERVICE_URL || 'http://log-service-yago:3002';

// Extração segura do IP da requisição
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || '';
}

// Dispara logs para o microsserviço de auditoria (Redis Streams)
async function registrarAuditoria(usuario_id, acao, detalhes = '', ip = '') {
  try {
    await axios.post(`${LOG_SERVICE_URL}/logs`, {
      usuario_id: String(usuario_id || 'anonimo'),
      acao,
      detalhes: String(detalhes || ''),
      ip: String(ip || '')
    }, { timeout: 3000 });
  } catch (error) {
    console.error('Erro ao enviar log para auditoria:', error.message);
  }
}

// Helper: checa premium no DB ou se é admin (Admins ganham recursos VIP automaticamente)
async function isPremiumOrAdmin(req) {
  if (!req.session?.usuario) return false;
  if (req.session.usuario.role === 'admin') return true;
  try {
    const [rows] = await pool.query('SELECT premium, role FROM usuarios WHERE id = ?', [req.session.usuario.id]);
    return rows.length > 0 && (rows[0].premium == 1 || rows[0].role === 'admin');
  } catch {
    return req.session.usuario.premium == 1;
  }
}

// Middleware de Autenticação Comum
function authMiddleware(req, res, next) {
  if (!req.session.usuario) return res.status(401).json({ error: 'Faça login.' });
  next();
}

// Middleware Premium (RBAC) - Admins possuem todos os recursos VIP liberados
async function premiumMiddleware(req, res, next) {
  if (!req.session.usuario) return res.status(401).json({ error: 'Faça login.' });
  const ok = await isPremiumOrAdmin(req);
  if (!ok) return res.status(403).json({ error: 'Recurso exclusivo para utilizadores VIP ou Administradores.' });
  next();
}

// Middleware para Rotas Exclusivas do Administrador (RBAC)
async function adminMiddleware(req, res, next) {
  if (!req.session.usuario) {
    return res.status(401).json({ error: 'Faça login.' });
  }

  if (req.session.usuario.role !== 'admin') {
    const ip = getClientIp(req);
    await registrarAuditoria(
      req.session.usuario.id,
      'tentativa_negada_403',
      `Tentou acessar [${req.method} ${req.originalUrl}] sem permissão de administrador`,
      ip
    );
    return res.status(403).json({ error: 'Acesso negado: privilégios de administrador necessários.' });
  }

  next();
}

// --- ROTAS REPASSADAS AO AUTH-SERVICE VIA REDE INTERNA ---
app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    const response = await axios.post(`${AUTH_SERVICE_URL}/register`, req.body, {
      headers: { 'x-forwarded-for': getClientIp(req) }
    });
    res.status(response.status).json(response.data);
  } catch (err) {
    res.status(err.response?.status || 500).json(err.response?.data || { error: 'Erro no serviço de autenticação' });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const response = await axios.post(`${AUTH_SERVICE_URL}/login`, req.body, {
      headers: { 'x-forwarded-for': getClientIp(req) }
    });
    req.session.usuario = response.data;
    res.json(response.data);
  } catch (err) {
    res.status(err.response?.status || 500).json(err.response?.data || { error: 'Credenciais inválidas.' });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  const usuario = req.session.usuario;
  const ip = getClientIp(req);

  if (usuario) {
    // AUDITORIA: Logout registrado
    await registrarAuditoria(usuario.id, 'logout', `Sessão encerrada pelo usuário ${usuario.email}`, ip);
  }

  req.session.destroy(() => {
    res.clearCookie('session_cookie');
    res.json({ message: 'Logout realizado.' });
  });
});

app.get('/api/auth/me', async (req, res) => {
  if (!req.session.usuario) return res.status(401).json({ error: 'Deslogado' });
  // Sincroniza status premium e perfil da sessão com o DB
  try {
    const [rows] = await pool.query('SELECT role, premium, avatar_url, banner_url, stripe_customer_id FROM usuarios WHERE id = ?', [req.session.usuario.id]);
    if (rows.length > 0) {
      req.session.usuario.role = rows[0].role;
      req.session.usuario.premium  = (rows[0].role === 'admin' || rows[0].premium == 1) ? 1 : 0;
      req.session.usuario.avatar_url = normalizarStorageUrl(rows[0].avatar_url);
      req.session.usuario.banner_url = normalizarStorageUrl(rows[0].banner_url);
      req.session.usuario.stripe_customer_id = rows[0].stripe_customer_id;
    }
  } catch {}
  res.json(req.session.usuario);
});

app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
  try {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const response = await axios.post(`${AUTH_SERVICE_URL}/forgot-password`, {
      email: req.body.email,
      baseUrl
    }, {
      headers: { 'x-forwarded-for': getClientIp(req) }
    });
    res.json(response.data);
  } catch (err) {
    res.status(err.response?.status || 500).json(err.response?.data || { error: 'Erro ao solicitar recuperação.' });
  }
});

app.post('/api/auth/reset-password', authLimiter, async (req, res) => {
  try {
    const response = await axios.post(`${AUTH_SERVICE_URL}/reset-password`, req.body, {
      headers: { 'x-forwarded-for': getClientIp(req) }
    });
    res.json(response.data);
  } catch (err) {
    res.status(err.response?.status || 500).json(err.response?.data || { error: 'Erro ao redefinir senha.' });
  }
});

// Alterar senha autenticado (usa sessão, sem token)
app.post('/api/auth/change-password', authMiddleware, async (req, res) => {
  const { novaSenha } = req.body;
  if (!novaSenha || novaSenha.length < 6) {
    return res.status(400).json({ error: 'Senha deve ter pelo menos 6 caracteres.' });
  }
  const ip = getClientIp(req);
  try {
    const response = await axios.post(`${AUTH_SERVICE_URL}/change-password`, {
      usuario_id: req.session.usuario.id,
      novaSenha
    }, {
      headers: { 'x-forwarded-for': ip }
    });
    await registrarAuditoria(req.session.usuario.id, 'senha_alterada', 'Usuário alterou a própria senha', ip);
    res.json(response.data);
  } catch (err) {
    res.status(err.response?.status || 500).json(err.response?.data || { error: 'Erro ao alterar senha.' });
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// STRIPE — Configuração Pública
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/stripe/config', (req, res) => {
  res.json({ publishableKey: STRIPE_PUBLISHABLE_KEY });
});

// ─────────────────────────────────────────────────────────────────────────────
// STRIPE — Checkout Session
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/stripe/checkout', authMiddleware, async (req, res) => {
  try {
    // Detecta URL base de retorno dinamicamente para suportar localhost em qualquer porta
    let baseUrl = APP_URL;
    if (!baseUrl) {
      const referer = req.get('referer');
      if (referer) {
        try { baseUrl = new URL(referer).origin; } catch {}
      }
    }
    if (!baseUrl) {
      const host = req.get('host') || 'localhost:8228';
      baseUrl = `${req.protocol}://${host}`;
    }

    // Se houver um Price ID configurado, usa ele; senão cria o item de assinatura diretamente
    const line_items = STRIPE_PRICE_ID
      ? [{ price: STRIPE_PRICE_ID, quantity: 1 }]
      : [{
          price_data: {
            currency: 'brl',
            product_data: {
              name: 'Tom Hanks Fan Club - Assinatura Premium VIP',
              description: 'Reviews em áudio no MinIO, moldura dourada, badge VIP e uploads de até 10MB'
            },
            unit_amount: 1990, // R$ 19,90 por mês
            recurring: {
              interval: 'month'
            }
          },
          quantity: 1
        }];

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items,
      customer_email: req.session.usuario.email || undefined,
      success_url: `${baseUrl}/?premium=sucesso&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${baseUrl}/?premium=cancelado`,
      client_reference_id: String(req.session.usuario.id),
      metadata: { usuario_id: String(req.session.usuario.id) }
    });

    res.json({ url: checkoutSession.url });
  } catch (err) {
    console.error('[Stripe] Erro ao criar checkout:', err.message);
    res.status(500).json({ error: `Erro ao iniciar o checkout: ${err.message}` });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// STRIPE — Verificação de Sessão (Retorno imediato sem necessidade de webhook no localhost)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/stripe/verify-session', authMiddleware, async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) {
    return res.status(400).json({ error: 'session_id obrigatório' });
  }

  try {
    const sess = await stripe.checkout.sessions.retrieve(session_id);
    if (sess.status === 'complete' || sess.payment_status === 'paid') {
      const usuarioId = sess.client_reference_id || sess.metadata?.usuario_id || req.session.usuario.id;
      
      try {
        await pool.query(
          'UPDATE usuarios SET premium = 1, stripe_customer_id = ? WHERE id = ?',
          [sess.customer || null, usuarioId]
        );
      } catch (dbErr) {
        console.warn('[Stripe] Erro ao atualizar DB na verificação:', dbErr.message);
      }
      
      if (req.session.usuario && req.session.usuario.id == usuarioId) {
        req.session.usuario.premium = 1;
        req.session.usuario.stripe_customer_id = sess.customer || null;
      }

      await registrarAuditoria(
        usuarioId,
        'upgrade_premium',
        `Stripe Checkout concluído e verificado (Sessão: ${sess.id}, Customer: ${sess.customer || 'N/A'})`,
        getClientIp(req)
      );

      return res.json({ success: true, premium: true });
    }

    res.json({ success: false, status: sess.status, payment_status: sess.payment_status });
  } catch (err) {
    console.error('[Stripe] Erro ao verificar sessão:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// STRIPE — Sincronizar Assinatura (para usuários que já pagaram ou retorno pendente)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/stripe/sincronizar', authMiddleware, async (req, res) => {
  try {
    const usuario = req.session.usuario;

    // Se for admin, já tem os benefícios VIP
    if (usuario.role === 'admin') {
      req.session.usuario.premium = 1;
      return res.json({ success: true, premium: true, message: 'Administrador possui todos os benefícios VIP.' });
    }

    let customerId = usuario.stripe_customer_id;

    // Se não tem customerId, busca na Stripe pelo e-mail
    if (!customerId && usuario.email) {
      try {
        const customers = await stripe.customers.list({ email: usuario.email.trim().toLowerCase(), limit: 1 });
        if (customers.data.length > 0) {
          customerId = customers.data[0].id;
        }
      } catch {}
    }

    let isSubscribed = false;

    // Checa subscriptions ativas
    if (customerId) {
      try {
        const subscriptions = await stripe.subscriptions.list({
          customer: customerId,
          status: 'active',
          limit: 1
        });
        if (subscriptions.data.length > 0) {
          isSubscribed = true;
        }
      } catch {}
    }

    // Se não encontrou pelo customer, checa as últimas checkout sessions pagas
    if (!isSubscribed) {
      try {
        const sessions = await stripe.checkout.sessions.list({ limit: 15 });
        const userSession = sessions.data.find(s =>
          (s.customer_email === usuario.email || s.customer_details?.email === usuario.email || s.client_reference_id == usuario.id) &&
          (s.payment_status === 'paid' || s.status === 'complete')
        );
        if (userSession) {
          isSubscribed = true;
          customerId = userSession.customer || customerId;
        }
      } catch {}
    }

    if (isSubscribed) {
      await pool.query(
        'UPDATE usuarios SET premium = 1, stripe_customer_id = ? WHERE id = ?',
        [customerId || null, usuario.id]
      );
      req.session.usuario.premium = 1;
      req.session.usuario.stripe_customer_id = customerId;
      await registrarAuditoria(usuario.id, 'upgrade_premium', `Assinatura Stripe sincronizada e confirmada (${customerId})`, getClientIp(req));
      return res.json({ success: true, premium: true, message: 'Assinatura VIP reconhecida e ativa!' });
    }

    res.json({ success: false, premium: false, message: 'Nenhuma assinatura ativa encontrada para este usuário no Stripe.' });
  } catch (err) {
    console.error('[Stripe] Erro ao sincronizar:', err.message);
    res.status(500).json({ error: 'Erro ao sincronizar: ' + err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// STRIPE — Cancelar Assinatura VIP
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/stripe/cancelar', authMiddleware, async (req, res) => {
  try {
    const usuario = req.session.usuario;
    let customerId = usuario.stripe_customer_id;

    if (!customerId && usuario.email) {
      try {
        const customers = await stripe.customers.list({ email: usuario.email.trim().toLowerCase(), limit: 1 });
        if (customers.data.length > 0) {
          customerId = customers.data[0].id;
        }
      } catch {}
    }

    let canceladas = 0;
    if (customerId) {
      try {
        const subscriptions = await stripe.subscriptions.list({
          customer: customerId,
          status: 'active'
        });
        for (const sub of subscriptions.data) {
          await stripe.subscriptions.cancel(sub.id);
          canceladas++;
        }
      } catch (subErr) {
        console.warn('[Stripe] Erro ao cancelar subscriptions:', subErr.message);
      }
    }

    await pool.query('UPDATE usuarios SET premium = 0 WHERE id = ?', [usuario.id]);
    if (usuario.role !== 'admin') {
      req.session.usuario.premium = 0;
    }

    await registrarAuditoria(usuario.id, 'cancelar_premium', `Assinatura VIP cancelada (${canceladas} ativas removidas no Stripe)`, getClientIp(req));
    res.json({ success: true, message: 'Assinatura VIP cancelada com sucesso.' });
  } catch (err) {
    console.error('[Stripe] Erro ao cancelar:', err.message);
    res.status(500).json({ error: 'Erro ao cancelar assinatura: ' + err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// STRIPE — Webhook (raw body antes do express.json)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    let event;
    try {
      if (STRIPE_WEBHOOK_SECRET) {
        const sig = req.headers['stripe-signature'];
        event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
      } else {
        event = JSON.parse(req.body.toString());
      }
    } catch (err) {
      console.error('[Stripe Webhook] Assinatura inválida:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
      const sess = event.data.object;
      const usuarioId = sess.client_reference_id || sess.metadata?.usuario_id;
      if (usuarioId) {
        try {
          await pool.query(
            'UPDATE usuarios SET premium = 1, stripe_customer_id = ? WHERE id = ?',
            [sess.customer, usuarioId]
          );
          console.log(`[Stripe] Usuário #${usuarioId} agora é PREMIUM.`);
          await registrarAuditoria(usuarioId, 'upgrade_premium',
            `Stripe checkout concluído (customer: ${sess.customer})`, '');
        } catch (dbErr) {
          console.error('[Stripe] Erro ao atualizar DB:', dbErr.message);
        }
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      const customerId = event.data.object.customer;
      try {
        await pool.query('UPDATE usuarios SET premium = 0 WHERE stripe_customer_id = ?', [customerId]);
        console.log(`[Stripe] Assinatura cancelada para customer ${customerId}.`);
      } catch {}
    }

    res.json({ received: true });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// MINIO — Upload Avatar
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/perfil/avatar', authMiddleware, uploadImage.single('avatar'), async (req, res) => {
  try {
    const userId  = req.session.usuario.id;
    const premium = await isPremium(userId);
    const maxSize = premium ? 10 * 1024 * 1024 : 1 * 1024 * 1024;

    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    if (req.file.size > maxSize) {
      return res.status(400).json({
        error: premium
          ? 'Tamanho máximo para Premium é 10 MB.'
          : 'Utilizadores comuns podem enviar até 1 MB. Assine o Premium para até 10 MB!'
      });
    }

    const ext = req.file.originalname.split('.').pop();
    const objectName = `avatar_${userId}_${Date.now()}.${ext}`;
    await minioClient.putObject(AVATAR_BUCKET, objectName, req.file.buffer, req.file.size, { 'Content-Type': req.file.mimetype });

    const avatarUrl = `/api/storage/${AVATAR_BUCKET}/${objectName}`;
    await pool.query('UPDATE usuarios SET avatar_url = ? WHERE id = ?', [avatarUrl, userId]);
    req.session.usuario.avatar_url = avatarUrl;

    await registrarAuditoria(userId, 'upload_avatar', `Avatar salvo no MinIO: ${objectName}`, getClientIp(req));
    res.json({ url: avatarUrl });
  } catch (err) {
    console.error('[MinIO] Erro upload avatar:', err.message);
    res.status(500).json({ error: 'Erro ao fazer upload do avatar.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// MINIO — Upload Banner (apenas Premium)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/perfil/banner', premiumMiddleware, uploadImage.single('banner'), async (req, res) => {
  try {
    const userId = req.session.usuario.id;
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    if (req.file.size > 10 * 1024 * 1024) return res.status(400).json({ error: 'Máximo 10 MB.' });

    const ext = req.file.originalname.split('.').pop();
    const objectName = `banner_${userId}_${Date.now()}.${ext}`;
    await minioClient.putObject(BANNER_BUCKET, objectName, req.file.buffer, req.file.size, { 'Content-Type': req.file.mimetype });

    const bannerUrl = `/api/storage/${BANNER_BUCKET}/${objectName}`;
    await pool.query('UPDATE usuarios SET banner_url = ? WHERE id = ?', [bannerUrl, userId]);
    req.session.usuario.banner_url = bannerUrl;

    await registrarAuditoria(userId, 'upload_banner', `Banner salvo no MinIO: ${objectName}`, getClientIp(req));
    res.json({ url: bannerUrl });
  } catch (err) {
    console.error('[MinIO] Erro upload banner:', err.message);
    res.status(500).json({ error: 'Erro ao fazer upload do banner.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// MINIO — Upload de Crítica em Áudio (apenas Premium)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/comentarios/audio', premiumMiddleware, uploadAudio.single('audio'), async (req, res) => {
  const ip = getClientIp(req);
  try {
    const { tmdb_movie_id } = req.body;
    if (!tmdb_movie_id) return res.status(400).json({ error: 'tmdb_movie_id é obrigatório.' });
    if (!req.file)       return res.status(400).json({ error: 'Nenhum arquivo de áudio enviado.' });

    const userId = req.session.usuario.id;
    const ext = (req.file.originalname.split('.').pop()) || 'webm';
    const objectName = `audio_${userId}_${tmdb_movie_id}_${Date.now()}.${ext}`;
    await minioClient.putObject(AUDIO_BUCKET, objectName, req.file.buffer, req.file.size, { 'Content-Type': req.file.mimetype });

    const audioUrl = `/api/storage/${AUDIO_BUCKET}/${objectName}`;

    await pool.query(
      'INSERT INTO comentarios (usuario_id, tmdb_movie_id, texto, audio_url) VALUES (?, ?, ?, ?)',
      [userId, tmdb_movie_id, '[🎤 Crítica em Áudio]', audioUrl]
    );

    await registrarAuditoria(userId, 'criar_comentario_audio',
      `Áudio enviado para Filme ID ${tmdb_movie_id}: ${objectName}`, ip);
    res.status(201).json({ message: 'Crítica em áudio publicada!', url: audioUrl });
  } catch (err) {
    console.error('[MinIO] Erro upload áudio:', err.message);
    res.status(500).json({ error: 'Erro ao publicar crítica em áudio.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// MINIO — Proxy Seguro de Mídia (resolve DNS Docker 'minio' e bloqueios de CSP)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/storage/:bucket/:objectName', async (req, res) => {
  try {
    const { bucket, objectName } = req.params;
    const allowed = [AVATAR_BUCKET, AUDIO_BUCKET, BANNER_BUCKET];
    if (!allowed.includes(bucket)) return res.status(403).json({ error: 'Bucket inválido.' });

    const stat = await minioClient.statObject(bucket, objectName);
    res.setHeader('Content-Type', stat.metaData['content-type'] || 'audio/mpeg');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=86400');

    const stream = await minioClient.getObject(bucket, objectName);
    stream.pipe(res);
  } catch (err) {
    console.error('[Storage Proxy] Erro ao buscar objeto:', err.message);
    res.status(404).json({ error: 'Mídia não encontrada.' });
  }
});

// --- ROTAS DO CATÁLOGO TMDB ---
app.get('/api/filmes', authMiddleware, async (req, res) => {
  try {
    const response = await axios.get(
      `https://api.themoviedb.org/3/person/31/movie_credits?api_key=${process.env.TMDB_API_KEY}&language=pt-BR`
    );
    res.json(response.data.cast || []);
  } catch (err) {
    res.status(500).json({ error: 'Erro TMDB.' });
  }
});

// --- FAVORITOS ---
app.get('/api/favoritos', authMiddleware, async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM favoritos WHERE usuario_id = ?', [req.session.usuario.id]);
  res.json(rows);
});

app.post('/api/favoritos', authMiddleware, async (req, res) => {
  const { tmdb_movie_id, titulo, poster_path } = req.body;
  const ip = getClientIp(req);
  try {
    await pool.query(
      'INSERT INTO favoritos (usuario_id, tmdb_movie_id, titulo, poster_path) VALUES (?, ?, ?, ?)',
      [req.session.usuario.id, tmdb_movie_id, titulo, poster_path]
    );
    // AUDITORIA: Favoritar filme
    await registrarAuditoria(req.session.usuario.id, 'favoritar_filme', `Filme: ${titulo} (ID: ${tmdb_movie_id})`, ip);
    res.status(201).json({ message: 'Favoritado' });
  } catch (err) {
    res.status(400).json({ error: 'Já favoritado' });
  }
});

app.delete('/api/favoritos/:id', authMiddleware, async (req, res) => {
  const ip = getClientIp(req);
  await pool.query('DELETE FROM favoritos WHERE usuario_id = ? AND tmdb_movie_id = ?', [req.session.usuario.id, req.params.id]);
  // AUDITORIA: Desfavoritar filme
  await registrarAuditoria(req.session.usuario.id, 'desfavoritar_filme', `Removeu dos favoritos o Filme ID: ${req.params.id}`, ip);
  res.json({ message: 'Removido' });
});

// --- COMENTÁRIOS ---
app.get('/api/comentarios/:id', authMiddleware, async (req, res) => {
  try {
    const is_admin = req.session.usuario.role === 'admin';

    let sql = `
      SELECT c.id, c.texto, c.audio_url, c.criado_em, c.usuario_id, u.nome, u.email,
             (CASE WHEN u.role = 'admin' OR u.premium = 1 THEN 1 ELSE 0 END) AS is_premium,
             u.role
      FROM comentarios c
      JOIN usuarios u ON c.usuario_id = u.id
      WHERE c.tmdb_movie_id = ?
    `;
    const params = [req.params.id];

    // Se NÃO for admin, vê somente os próprios comentários
    if (!is_admin) {
      sql += ' AND c.usuario_id = ?';
      params.push(req.session.usuario.id);
    }

    // Admins e Premiums aparecem no topo
    sql += ' ORDER BY (u.role = "admin" OR u.premium = 1) DESC, c.criado_em DESC';

    const [rows] = await pool.query(sql, params);
    const tratadas = rows.map(c => ({
      ...c,
      audio_url: normalizarStorageUrl(c.audio_url)
    }));
    res.json(tratadas);
  } catch (err) {
    console.warn('[Comentarios] Erro com query completa, executando fallback compatível:', err.message);
    try {
      let fallbackSql = `
        SELECT c.id, c.texto, NULL AS audio_url, c.criado_em, c.usuario_id, u.nome, u.email,
               (CASE WHEN u.role = 'admin' THEN 1 ELSE 0 END) AS is_premium,
               u.role
        FROM comentarios c
        JOIN usuarios u ON c.usuario_id = u.id
        WHERE c.tmdb_movie_id = ?
      `;
      const fallbackParams = [req.params.id];
      if (req.session.usuario.role !== 'admin') {
        fallbackSql += ' AND c.usuario_id = ?';
        fallbackParams.push(req.session.usuario.id);
      }
      fallbackSql += ' ORDER BY (u.role = "admin") DESC, c.criado_em DESC';
      const [fallbackRows] = await pool.query(fallbackSql, fallbackParams);
      res.json(fallbackRows);
    } catch (fbErr) {
      console.error('[Comentarios] Erro total ao buscar comentários:', fbErr.message);
      res.status(500).json({ error: 'Erro ao buscar comentários' });
    }
  }
});

app.post('/api/comentarios', authMiddleware, async (req, res) => {
  const ip = getClientIp(req);
  const textoLimpo = (req.body.texto || '').trim();
  
  if (!textoLimpo || !req.body.tmdb_movie_id) {
    return res.status(400).json({ error: 'Texto e ID do filme são obrigatórios.' });
  }

  await pool.query(
    'INSERT INTO comentarios (usuario_id, tmdb_movie_id, texto) VALUES (?, ?, ?)',
    [req.session.usuario.id, req.body.tmdb_movie_id, textoLimpo]
  );
  
  // AUDITORIA: Criar comentário
  await registrarAuditoria(
    req.session.usuario.id,
    'criar_comentario',
    `Comentou no Filme ID ${req.body.tmdb_movie_id}: "${textoLimpo.substring(0, 40)}"`,
    ip
  );
  res.status(201).json({ message: 'Comentado' });
});

app.delete('/api/comentarios/:id', authMiddleware, async (req, res) => {
  const ip = getClientIp(req);
  try {
    const is_admin = req.session.usuario.role === 'admin';
    
    let sql = 'DELETE FROM comentarios WHERE id = ?';
    const params = [req.params.id];

    if (!is_admin) {
      sql += ' AND usuario_id = ?';
      params.push(req.session.usuario.id);
    }

    const [result] = await pool.query(sql, params);
    
    if (result.affectedRows === 0) {
      // Verifica se o comentário existe para registrar a tentativa não autorizada (403)
      const [existe] = await pool.query('SELECT usuario_id FROM comentarios WHERE id = ?', [req.params.id]);
      if (existe.length > 0 && !is_admin) {
        await registrarAuditoria(
          req.session.usuario.id,
          'tentativa_negada_403',
          `Tentou apagar comentário ID: ${req.params.id} de outro usuário sem permissão`,
          ip
        );
        return res.status(403).json({ error: 'Não autorizado: você só pode apagar seus próprios comentários.' });
      }
      return res.status(404).json({ error: 'Comentário não encontrado.' });
    }
    
    // AUDITORIA: Sucesso na exclusão
    await registrarAuditoria(
      req.session.usuario.id,
      'deletar_comentario',
      `${is_admin ? 'Admin moderou e apagou' : 'Autor apagou'} o comentário ID: ${req.params.id}`,
      ip
    );
    res.json({ message: 'Comentário apagado com sucesso.' });
  } catch (err) {
    console.error('Erro ao apagar comentário:', err);
    res.status(500).json({ error: 'Erro ao apagar comentário.' });
  }
});

// --- ROTAS DO PAINEL ADMINISTRATIVO ---

app.get('/api/admin/comentarios', adminMiddleware, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT c.id, c.tmdb_movie_id, c.texto, c.audio_url, c.criado_em, c.usuario_id,
             u.nome, u.email, (CASE WHEN u.role = 'admin' OR u.premium = 1 THEN 1 ELSE 0 END) AS is_premium,
             u.role
      FROM comentarios c
      JOIN usuarios u ON c.usuario_id = u.id
      ORDER BY c.criado_em DESC
      LIMIT 100
    `);
    const tratadas = rows.map(c => ({
      ...c,
      audio_url: normalizarStorageUrl(c.audio_url)
    }));
    res.json(tratadas);
  } catch (err) {
    console.warn('[Admin Comentarios] Tentando fallback:', err.message);
    try {
      const [fallbackRows] = await pool.query(`
        SELECT c.id, c.tmdb_movie_id, c.texto, NULL AS audio_url, c.criado_em, c.usuario_id,
               u.nome, u.email, (CASE WHEN u.role = 'admin' THEN 1 ELSE 0 END) AS is_premium,
               u.role
        FROM comentarios c
        JOIN usuarios u ON c.usuario_id = u.id
        ORDER BY c.criado_em DESC
        LIMIT 100
      `);
      res.json(fallbackRows);
    } catch (fbErr) {
      console.error('Erro crítico ao listar comentários para admin:', fbErr.message);
      res.status(500).json({ error: 'Erro ao carregar comentários para moderação.' });
    }
  }
});

// 2. Listar logs de auditoria no Redis Streams (Exclusivo Admin)
app.get('/api/logs', adminMiddleware, async (req, res) => {
  try {
    const limit = req.query.limit || 100;
    const response = await axios.get(`${LOG_SERVICE_URL}/logs?limit=${limit}`);
    res.json(response.data);
  } catch (err) {
    console.error('Erro ao consultar log-service:', err.message);
    res.status(500).json({ error: 'Erro ao consultar microsserviço de auditoria.' });
  }
});

// 3. Apagar um registro de log de auditoria no Redis Streams (Exclusivo Admin)
app.delete('/api/logs/:id', adminMiddleware, async (req, res) => {
  const ip = getClientIp(req);
  try {
    const response = await axios.delete(`${LOG_SERVICE_URL}/logs/${req.params.id}`);
    
    // AUDITORIA: Registra que um log foi apagado
    await registrarAuditoria(
      req.session.usuario.id,
      'deletar_log',
      `Admin apagou o registro de auditoria ID ${req.params.id}`,
      ip
    );

    res.json(response.data);
  } catch (err) {
    console.error('Erro ao apagar log no log-service:', err.message);
    res.status(err.response?.status || 500).json(err.response?.data || { error: 'Erro ao apagar log de auditoria.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Catálogo rodando na porta ${PORT}`));