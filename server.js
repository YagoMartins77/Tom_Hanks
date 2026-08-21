require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const mysql = require('mysql2/promise');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Pool de conexão com MariaDB
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: Number(process.env.DB_PORT) || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'chave-secreta-padrao',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 1000 * 60 * 60 * 24 } // 1 dia
}));

// Middleware de Autenticação
function authMiddleware(req, res, next) {
  if (!req.session.usuario) {
    return res.status(401).json({ error: 'Não autorizado. Faça login.' });
  }
  next();
}

app.use(express.static(path.join(__dirname, 'public')));

// ================= ROTAS DE AUTENTICAÇÃO =================

app.post('/api/auth/register', async (req, res) => {
  const { nome, email, senha } = req.body;
  if (!nome || !email || !senha) return res.status(400).json({ error: 'Preencha todos os campos.' });

  try {
    const senhaHash = await bcrypt.hash(senha, 10);
    const [result] = await db.execute(
      'INSERT INTO usuarios (nome, email, senha_hash) VALUES (?, ?, ?)',
      [nome, email, senhaHash]
    );
    req.session.usuario = { id: result.insertId, nome, email };
    res.json({ message: 'Conta criada com sucesso!', usuario: req.session.usuario });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'E-mail já cadastrado.' });
    }
    res.status(500).json({ error: 'Erro ao registrar usuário.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, senha } = req.body;
  try {
    const [rows] = await db.execute('SELECT * FROM usuarios WHERE email = ?', [email]);
    if (rows.length === 0) return res.status(401).json({ error: 'Credenciais inválidas.' });

    const usuario = rows[0];
    const match = await bcrypt.compare(senha, usuario.senha_hash);
    if (!match) return res.status(401).json({ error: 'Credenciais inválidas.' });

    req.session.usuario = { id: usuario.id, nome: usuario.nome, email: usuario.email };
    res.json({ message: 'Login realizado com sucesso!', usuario: req.session.usuario });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao realizar login.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ message: 'Sessão encerrada.' });
});

app.get('/api/auth/me', (req, res) => {
  if (req.session.usuario) {
    return res.json({ usuario: req.session.usuario });
  }
  res.status(401).json({ error: 'Nenhum usuário logado.' });
});

// ================= ROTA DE FILMES (TMDB) =================

app.get('/api/filmes', authMiddleware, async (req, res) => {
  try {
    const tmdbKey = process.env.TMDB_API_KEY;
    
    // 1. Busca o ID do Tom Hanks
    const personRes = await axios.get(`https://api.themoviedb.org/3/search/person`, {
      params: { api_key: tmdbKey, query: 'Tom Hanks' }
    });

    if (!personRes.data.results.length) {
      return res.status(404).json({ error: 'Ator não encontrado.' });
    }
    const personId = personRes.data.results[0].id;

    // 2. Busca créditos de filmes do ator
    const creditsRes = await axios.get(`https://api.themoviedb.org/3/person/${personId}/movie_credits`, {
      params: { api_key: tmdbKey, language: 'pt-BR' }
    });

    const filmes = creditsRes.data.cast.map(f => ({
      id: f.id,
      title: f.title,
      overview: f.overview || 'Sinopse não disponível.',
      poster_path: f.poster_path ? `https://image.tmdb.org/t/p/w500${f.poster_path}` : null,
      raw_poster_path: f.poster_path
    }));

    res.json(filmes);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao consultar API da TMDB.' });
  }
});

// ================= ROTAS DE FAVORITOS =================

app.get('/api/favoritos', authMiddleware, async (req, res) => {
  const usuarioId = req.session.usuario.id;
  try {
    const [rows] = await db.execute(
      'SELECT tmdb_movie_id, titulo, poster_path, criado_em FROM favoritos WHERE usuario_id = ?',
      [usuarioId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar favoritos.' });
  }
});

app.post('/api/favoritos', authMiddleware, async (req, res) => {
  const usuarioId = req.session.usuario.id;
  const { tmdb_movie_id, titulo, poster_path } = req.body;

  try {
    await db.execute(
      'INSERT INTO favoritos (usuario_id, tmdb_movie_id, titulo, poster_path) VALUES (?, ?, ?, ?)',
      [usuarioId, tmdb_movie_id, titulo, poster_path]
    );
    res.status(201).json({ message: 'Filme favoritado com sucesso.' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'Filme já está nos favoritos.' });
    }
    res.status(500).json({ error: 'Erro ao salvar favorito.' });
  }
});

app.delete('/api/favoritos/:movieId', authMiddleware, async (req, res) => {
  const usuarioId = req.session.usuario.id;
  const { movieId } = req.params;

  try {
    await db.execute(
      'DELETE FROM favoritos WHERE usuario_id = ? AND tmdb_movie_id = ?',
      [usuarioId, movieId]
    );
    res.json({ message: 'Removido dos favoritos.' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao remover favorito.' });
  }
});

// ================= ROTAS DE COMENTÁRIOS =================

app.get('/api/comentarios', authMiddleware, async (req, res) => {
  const usuarioId = req.session.usuario.id;
  try {
    const [rows] = await db.execute(
      'SELECT id, tmdb_movie_id, texto, criado_em FROM comentarios WHERE usuario_id = ? ORDER BY criado_em DESC',
      [usuarioId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar comentários.' });
  }
});

app.post('/api/comentarios', authMiddleware, async (req, res) => {
  const usuarioId = req.session.usuario.id;
  const { tmdb_movie_id, texto } = req.body;

  if (!texto || !texto.trim()) {
    return res.status(400).json({ error: 'O comentário não pode ser vazio.' });
  }

  try {
    await db.execute(
      'INSERT INTO comentarios (usuario_id, tmdb_movie_id, texto) VALUES (?, ?, ?)',
      [usuarioId, tmdb_movie_id, texto]
    );
    res.status(201).json({ message: 'Comentário gravado com sucesso.' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao gravar comentário.' });
  }
});

app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));