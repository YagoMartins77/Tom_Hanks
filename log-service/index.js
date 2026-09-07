const express = require('express');
const { createClient } = require('redis');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3002;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const STREAM_KEY = 'auditoria:logs';

// Configuração do Cliente Redis
const redisClient = createClient({ url: REDIS_URL });
redisClient.on('error', (err) => console.error('Erro no Redis', err));
redisClient.connect().then(() => console.log('Log Service conectado ao Redis!'));

// Rota para GRAVAR o log (Recebe de outros microsserviços)
app.post('/logs', async (req, res) => {
    const { usuario_id, acao, detalhes } = req.body;

    try {
        // XADD insere o registro no Stream do Redis gerando um ID de timestamp automático
        const id = await redisClient.xAdd(STREAM_KEY, '*', {
            usuario_id: String(usuario_id || 'anonimo'),
            acao: String(acao),
            detalhes: String(detalhes || ''),
            data_hora: new Date().toISOString()
        });
        
        res.status(201).json({ message: 'Log registrado com sucesso', id });
    } catch (error) {
        console.error('Erro ao gravar log:', error);
        res.status(500).json({ error: 'Falha ao registrar auditoria' });
    }
});

// Rota para CONSULTAR os logs (Acessada apenas pelo Admin via catalogo-service)
app.get('/logs', async (req, res) => {
    try {
        // XREVRANGE pega os logs de trás pra frente (mais recentes primeiro)
        // O '+' e '-' indicam do máximo pro mínimo. COUNT 50 limita o tamanho.
        const logs = await redisClient.xRevRange(STREAM_KEY, '+', '-', { COUNT: 50 });
        
        // Mapeia o retorno do Redis para um JSON mais limpo
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

app.listen(PORT, () => console.log(`Log Service rodando na porta ${PORT}`));