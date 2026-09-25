const express = require('express');
const { createClient } = require('redis');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3002;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const STREAM_KEY = 'auditoria:logs';

// Configuração do Cliente Redis
const redisClient = createClient({ url: REDIS_URL });
redisClient.on('error', (err) => console.error('Erro no Redis:', err));
redisClient.connect().then(() => console.log('Log Service conectado ao Redis com sucesso!'));

// Rota para GRAVAR o log (Recebe de outros microsserviços via HTTP interno)
app.post('/logs', async (req, res) => {
    const { usuario_id, acao, detalhes, ip } = req.body;

    try {
        // XADD insere o registro no Stream do Redis gerando ID temporal automático
        const id = await redisClient.xAdd(STREAM_KEY, '*', {
            usuario_id: String(usuario_id || 'anonimo'),
            acao: String(acao || 'acao_desconhecida'),
            detalhes: String(detalhes || ''),
            ip: String(ip || ''),
            data_hora: new Date().toISOString()
        });
        
        res.status(201).json({ message: 'Log registrado com sucesso', id });
    } catch (error) {
        console.error('Erro ao gravar log:', error);
        res.status(500).json({ error: 'Falha ao registrar auditoria' });
    }
});

// Rota para CONSULTAR os logs (Admin)
app.get('/logs', async (req, res) => {
    try {
        const count = Math.min(parseInt(req.query.limit) || 100, 500);
        // XREVRANGE busca os logs do mais recente para o mais antigo
        const logs = await redisClient.xRevRange(STREAM_KEY, '+', '-', { COUNT: count });
        
        const formatado = logs.map(log => ({
            id_redis: log.id,
            ...log.message
        }));

        res.json(formatado);
    } catch (error) {
        console.error('Erro ao buscar logs:', error);
        res.status(500).json({ error: 'Falha ao recuperar auditoria' });
    }
});

// Rota para APAGAR um log específico no Redis Streams
app.delete('/logs/:id', async (req, res) => {
    const { id } = req.params;
    try {
        // XDEL remove o registro pelo ID dentro do Stream
        const deleted = await redisClient.xDel(STREAM_KEY, id);
        if (deleted === 0) {
            return res.status(404).json({ error: 'Log não encontrado ou já excluído.' });
        }

        res.json({ message: 'Log apagado com sucesso.', id });
    } catch (error) {
        console.error('Erro ao apagar log no Redis:', error);
        res.status(500).json({ error: 'Falha ao apagar registro de auditoria' });
    }
});

app.listen(PORT, () => console.log(`Log Service rodando internamente na porta ${PORT}`));