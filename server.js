require('dotenv').config();
const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcrypt');
const path = require('path');
const axios = require('axios');
const mysql = require('mysql2/promise');

const app = express();

// Proteção 1: Ocultar cabeçalhos do Express e definir políticas de segurança
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"], /* <-- ESSA É A LINHA MÁGICA QUE LIBERA O ONCLICK */
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      fontSrc: ["'self'", "https://cdnjs.cloudflare.com"],
      imgSrc: ["'self'", "https://image.tmdb.org", "data:"]
    }
  }
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const dbOptions = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: Number(process.env.DB_PORT) || 3306
};
const pool = mysql.createPool(dbOptions);

// Proteção 2: Sessão no Banco de Dados (Evita vazamento de memória e perda de login)
const sessionStore = new MySQLStore({}, pool);
app.use(session({
  key: 'session_cookie',
  secret: process.env.SESSION_SECRET || 'secret',
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 24 * 60 * 60 * 1000 }
}));

// Proteção 3: Bloqueio de Força Bruta (Máximo 20 tentativas a cada 15 min por IP)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Muitas tentativas. Tente novamente mais tarde.' }
});

function authMiddleware(req, res, next) {
  if (!req.session.usuario) return res.status(401).json({ error: 'Faça login.' });
  next();
}

// --- ROTAS DE AUTENTICAÇÃO ---

app.post('/api/auth/register', authLimiter, async (req, res) => {
  const { nome, email, senha } = req.body;
  try {
    // Proteção 4: Criptografia forte de senha com salt 12
    const hash = await bcrypt.hash(senha, 12);
    await pool.query('INSERT INTO usuarios (nome, email, senha_hash) VALUES (?, ?, ?)', [nome, email, hash]);
    res.status(201).json({ message: 'Registrado com sucesso!' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao registrar.' });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { email, senha } = req.body;
  try {
    const [rows] = await pool.query('SELECT * FROM usuarios WHERE email = ?', [email]);
    if (rows.length === 0) return res.status(401).json({ error: 'Credenciais inválidas.' });

    // Compara a senha digitada com o Hash do banco
    const match = await bcrypt.compare(senha, rows[0].senha_hash);
    if (!match) return res.status(401).json({ error: 'Credenciais inválidas.' });

    req.session.usuario = { id: rows[0].id, nome: rows[0].nome, email: rows[0].email };
    res.json(req.session.usuario);
  } catch (err) {
    res.status(500).json({ error: 'Erro no login.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ message: 'Logout realizado.' }));
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.usuario) return res.status(401).json({ error: 'Deslogado' });
  res.json(req.session.usuario);
});

// --- ROTAS DO CATÁLOGO TMDB ---
app.get('/api/filmes', authMiddleware, async (req, res) => {
  try {
    const response = await axios.get(`https://api.themoviedb.org/3/person/31/movie_credits?api_key=${process.env.TMDB_API_KEY}&language=pt-BR`);
    res.json(response.data.cast || []);
  } catch (err) {
    res.status(500).json({ error: 'Erro TMDB.' });
  }
});

// --- FAVORITOS & COMENTÁRIOS ---
app.get('/api/favoritos', authMiddleware, async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM favoritos WHERE usuario_id = ?', [req.session.usuario.id]);
  res.json(rows);
});

app.post('/api/favoritos', authMiddleware, async (req, res) => {
  const { tmdb_movie_id, titulo, poster_path } = req.body;
  try {
    await pool.query('INSERT INTO favoritos (usuario_id, tmdb_movie_id, titulo, poster_path) VALUES (?, ?, ?, ?)', [req.session.usuario.id, tmdb_movie_id, titulo, poster_path]);
    res.status(201).json({ message: 'Favoritado' });
  } catch (err) {
    res.status(400).json({ error: 'Já favoritado' });
  }
});

// Proteção 5: IDOR - Só deleta se o favorito for do próprio usuário
app.delete('/api/favoritos/:id', authMiddleware, async (req, res) => {
  await pool.query('DELETE FROM favoritos WHERE usuario_id = ? AND tmdb_movie_id = ?', [req.session.usuario.id, req.params.id]);
  res.json({ message: 'Removido' });
});

app.get('/api/comentarios/:id', authMiddleware, async (req, res) => {
  const [rows] = await pool.query(`SELECT c.id, c.texto, c.criado_em, u.nome FROM comentarios c JOIN usuarios u ON c.usuario_id = u.id WHERE c.tmdb_movie_id = ? ORDER BY c.criado_em DESC`, [req.params.id]);
  res.json(rows);
});

app.post('/api/comentarios', authMiddleware, async (req, res) => {
  await pool.query('INSERT INTO comentarios (usuario_id, tmdb_movie_id, texto) VALUES (?, ?, ?)', [req.session.usuario.id, req.body.tmdb_movie_id, req.body.texto.trim()]);
  res.status(201).json({ message: 'Comentado' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Catálogo seguro rodando na porta ${PORT}`));