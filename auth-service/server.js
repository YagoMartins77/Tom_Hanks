require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: Number(process.env.DB_PORT) || 3306,
  waitForConnections: true,
  connectionLimit: 10
});

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'sandbox.smtp.mailtrap.io',
  port: Number(process.env.SMTP_PORT) || 2525,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// Cadastro
app.post('/register', async (req, res) => {
  const { nome, email, senha, role } = req.body;
  if (!nome || !email || !senha) return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });

  try {
    const userRole = role === 'admin' ? 'admin' : 'usuario';
    const hash = await bcrypt.hash(senha, 12);
    const [result] = await pool.query(
      'INSERT INTO usuarios (nome, email, senha_hash, role) VALUES (?, ?, ?, ?)',
      [nome.trim(), email.trim().toLowerCase(), hash, userRole]
    );
    res.status(201).json({ id: result.insertId, nome, email, role: userRole });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'E-mail já cadastrado.' });
    res.status(500).json({ error: 'Erro ao registrar.' });
  }
});

// Login
app.post('/login', async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) return res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });

  try {
    const [rows] = await pool.query('SELECT * FROM usuarios WHERE email = ?', [email.trim().toLowerCase()]);
    if (rows.length === 0) return res.status(401).json({ error: 'Credenciais inválidas.' });

    const user = rows[0];
    const match = await bcrypt.compare(senha, user.senha_hash);
    if (!match) return res.status(401).json({ error: 'Credenciais inválidas.' });

    res.json({ id: user.id, nome: user.nome, email: user.email, role: user.role });
  } catch (err) {
    res.status(500).json({ error: 'Erro no login.' });
  }
});

// Solicitar Recuperação de Senha (Mailtrap)
app.post('/forgot-password', async (req, res) => {
  const { email, baseUrl } = req.body;
  if (!email) return res.status(400).json({ error: 'Informe o e-mail.' });

  try {
    const [users] = await pool.query('SELECT id, nome FROM usuarios WHERE email = ?', [email.trim().toLowerCase()]);
    if (users.length === 0) {
      return res.json({ message: 'Se o e-mail existir, o link de recuperação foi enviado.' });
    }

    const user = users[0];
    const token = crypto.randomBytes(32).toString('hex');
    const expiraEm = new Date(Date.now() + 30 * 60 * 1000); // 30 minutos

    await pool.query(
      'INSERT INTO reset_tokens (token, usuario_id, expira_em) VALUES (?, ?, ?)',
      [token, user.id, expiraEm]
    );

    const resetLink = `${baseUrl}/reset-password.html?token=${token}`;

    await transporter.sendMail({
      from: '"Catálogo Tom Hanks" <no-reply@tomhanks.dev>',
      to: email,
      subject: 'Recuperação de Senha',
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6;">
          <h2>Redefinição de Senha</h2>
          <p>Olá, <strong>${user.nome}</strong>!</p>
          <p>Você solicitou a recuperação da sua senha.</p>
          <p><a href="${resetLink}" style="background-color: #e50914; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block;">Redefinir Minha Senha</a></p>
          <p>Este link expira em <strong>30 minutos</strong> e só pode ser usado uma vez.</p>
        </div>
      `
    });

    res.json({ message: 'Se o e-mail existir, o link de recuperação foi enviado.' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao processar recuperação.' });
  }
});

// Redefinir Senha
app.post('/reset-password', async (req, res) => {
  const { token, novaSenha } = req.body;
  if (!token || !novaSenha || novaSenha.length < 6) {
    return res.status(400).json({ error: 'Token inválido ou senha muito curta.' });
  }

  try {
    const [rows] = await pool.query(
      'SELECT * FROM reset_tokens WHERE token = ? AND usado = FALSE AND expira_em > NOW()',
      [token]
    );

    if (rows.length === 0) {
      return res.status(400).json({ error: 'Token inválido, já utilizado ou expirado após 30 minutos.' });
    }

    const resetRecord = rows[0];
    const hash = await bcrypt.hash(novaSenha, 12);

    await pool.query('UPDATE usuarios SET senha_hash = ? WHERE id = ?', [hash, resetRecord.usuario_id]);
    await pool.query('UPDATE reset_tokens SET usado = TRUE WHERE id = ?', [resetRecord.id]);

    res.json({ message: 'Senha atualizada com sucesso!' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar senha.' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Auth Service rodando internamente na porta ${PORT}`));