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

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth-service:3001';

function authMiddleware(req, res, next) {
  if (!req.session.usuario) return res.status(401).json({ error: 'Faça login.' });
  next();
}

// --- ROTAS REPASSADAS AO AUTH-SERVICE VIA REDE INTERNA ---
app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    const response = await axios.post(`${AUTH_SERVICE_URL}/register`, req.body);
    res.status(response.status).json(response.data);
  } catch (err) {
    res.status(err.response?.status || 500).json(err.response?.data || { error: 'Erro no serviço de autenticação' });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const response = await axios.post(`${AUTH_SERVICE_URL}/login`, req.body);
    req.session.usuario = response.data;
    res.json(response.data);
  } catch (err) {
    res.status(err.response?.status || 500).json(err.response?.data || { error: 'Credenciais inválidas.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
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
    });
    res.json(response.data);
  } catch (err) {
    res.status(err.response?.status || 500).json(err.response?.data || { error: 'Erro ao solicitar recuperação.' });
  }
});

app.post('/api/auth/reset-password', authLimiter, async (req, res) => {
  try {
    const response = await axios.post(`${AUTH_SERVICE_URL}/reset-password`, req.body);
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

// --- FAVORITOS & COMENTÁRIOS ISOLADOS ---
app.get('/api/favoritos', authMiddleware, async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM favoritos WHERE usuario_id = ?', [req.session.usuario.id]);
  res.json(rows);
});

app.post('/api/favoritos', authMiddleware, async (req, res) => {
  const { tmdb_movie_id, titulo, poster_path } = req.body;
  try {
    await pool.query(
      'INSERT INTO favoritos (usuario_id, tmdb_movie_id, titulo, poster_path) VALUES (?, ?, ?, ?)',
      [req.session.usuario.id, tmdb_movie_id, titulo, poster_path]
    );
    res.status(201).json({ message: 'Favoritado' });
  } catch (err) {
    res.status(400).json({ error: 'Já favoritado' });
  }
});

app.delete('/api/favoritos/:id', authMiddleware, async (req, res) => {
  await pool.query('DELETE FROM favoritos WHERE usuario_id = ? AND tmdb_movie_id = ?', [req.session.usuario.id, req.params.id]);
  res.json({ message: 'Removido' });
});

app.get('/api/comentarios/:id', authMiddleware, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT c.id, c.texto, c.criado_em, c.usuario_id, u.nome 
     FROM comentarios c 
     JOIN usuarios u ON c.usuario_id = u.id 
     WHERE c.tmdb_movie_id = ? AND c.usuario_id = ? 
     ORDER BY c.criado_em DESC`,
    [req.params.id, req.session.usuario.id]
  );
  res.json(rows);
});

app.post('/api/comentarios', authMiddleware, async (req, res) => {
  await pool.query(
    'INSERT INTO comentarios (usuario_id, tmdb_movie_id, texto) VALUES (?, ?, ?)',
    [req.session.usuario.id, req.body.tmdb_movie_id, req.body.texto.trim()]
  );
  res.status(201).json({ message: 'Comentado' });
});

app.delete('/api/comentarios/:id', authMiddleware, async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM comentarios WHERE id = ? AND usuario_id = ?', [req.params.id, req.session.usuario.id]);
    if (result.affectedRows === 0) return res.status(403).json({ error: 'Não autorizado.' });
    res.json({ message: 'Apagado' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao apagar.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Catálogo rodando na porta ${PORT}`));