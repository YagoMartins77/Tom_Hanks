require('dotenv').config();
const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const axios = require('axios');
const mysql = require('mysql2/promise');

const app = express();

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      fontSrc: ["'self'", "https://cdnjs.cloudflare.com"],
      imgSrc: ["'self'", "https://image.tmdb.org", "data:"]
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

// Middleware de Autenticação Comum
function authMiddleware(req, res, next) {
  if (!req.session.usuario) return res.status(401).json({ error: 'Faça login.' });
  next();
}

// Middleware para Rotas Exclusivas do Administrador (RBAC)
async function adminMiddleware(req, res, next) {
  if (!req.session.usuario) {
    return res.status(401).json({ error: 'Faça login.' });
  }

  if (req.session.usuario.role !== 'admin') {
    const ip = getClientIp(req);
    // AUDITORIA: Tentativa negada de acesso a rota admin (403)
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

app.get('/api/auth/me', (req, res) => {
  if (!req.session.usuario) return res.status(401).json({ error: 'Deslogado' });
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
      SELECT c.id, c.texto, c.criado_em, c.usuario_id, u.nome, u.email
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

    sql += ' ORDER BY c.criado_em DESC';

    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar comentários' });
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

// 1. Listar todos os comentários para moderação do admin
app.get('/api/admin/comentarios', adminMiddleware, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT c.id, c.tmdb_movie_id, c.texto, c.criado_em, c.usuario_id, u.nome, u.email
      FROM comentarios c
      JOIN usuarios u ON c.usuario_id = u.id
      ORDER BY c.criado_em DESC
      LIMIT 100
    `);
    res.json(rows);
  } catch (err) {
    console.error('Erro ao listar comentários para admin:', err);
    res.status(500).json({ error: 'Erro ao carregar comentários para moderação.' });
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