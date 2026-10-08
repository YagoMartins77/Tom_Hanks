# Catálogo de Filmes — Tom Hanks

Aplicação desenvolvida para consumo da API do TMDB, com persistência e segregação de favoritos e comentários por usuário no MariaDB.

**Professor:** @siriani

## Tecnologias
- Node.js & Express
- MariaDB
- Axios & Bcrypt & Express-Session
- Docker

## Como Executar Localmente
1. Clone o repositório.
2. Copie o arquivo `.env.example` para `.env` e preencha as credenciais.
3. Instale as dependências: `npm install`
4. Inicie o servidor: `npm start`

# Catálogo Tom Hanks — Microsserviços (Atividade 3)

Projeto desenvolvido para a disciplina do professor [@siriani](https://github.com/siriani).

## Arquitetura Desacoplada
- **Auth Service (`auth-service`):** Container dedicado exclusivamente a registro, login, papéis de usuário (`role`) e recuperação de senha. Funciona sem porta exposta para a internet.
- **Catálogo Service (`catalogo-service`):** Único ponto de entrada público. Repassa requisições de autenticação ao `auth-service` pela rede interna Docker (`http://auth-service:3001`).
- **Recuperação de Senha:** Envio de e-mail via Mailtrap com tokens de uso único e expiração de 30 minutos na tabela `reset_tokens`.

## Atividade 4: Controle de Acesso por Papel (RBAC)

### 1. Permissões documentadas por papel
Neste sistema, aplicamos o conceito de RBAC, onde permissões são atribuídas a papéis e não a pessoas individuais.
* **Papel `usuario`:** Pode visualizar o catálogo, realizar autenticação, adicionar comentários aos filmes e apagar **apenas os seus próprios** comentários.
* **Papel `admin`:** Possui todas as permissões do `usuario` e, adicionalmente, tem a permissão de moderação: consegue ver os comentários de todos os usuários (com e-mail de identificação) e pode **apagar o comentário de qualquer pessoa** no sistema.

### 2. Resposta de Arquitetura: Padrão A ou B?
Atualmente, nosso sistema utiliza o **Padrão A (Enforcement Centralizado)**. Toda ação sensível faz com que a aplicação faça uma chamada de rede para consultar o serviço (ou o banco) e verificar se o usuário tem permissão. 

Se fôssemos mudar para o **Padrão B (Claims no JWT)**, o papel (`role`) do usuário viria embutido dentro de um token assinado. A principal mudança no código seria que o serviço não precisaria mais ir até o banco ou fazer uma chamada externa para validar a permissão; ele apenas decodificaria o token localmente e decidiria sozinho. Isso deixaria o sistema mais rápido, porém, se o papel de um usuário fosse alterado no banco, a mudança não seria imediata, tendo efeito apenas quando o token expirasse e fosse renovado.

---

## Atividade: Logs e Auditoria — Quem fez o quê, e quando

Nesta etapa, implementamos um sistema de logs de auditoria para rastrear o comportamento dos usuários e ações críticas no sistema (diferente de logs de erro/debug).

### 1. Arquitetura do `log-service` e Escolha do Redis
- **Microsserviço Isolado (`log-service`):** Criado em um container próprio (`log-service-yago`), rodando na porta interna `3002`, conectado apenas à rede interna (`app-network`) do Docker e sem nenhuma porta exposta para a internet.
- **Por que Redis Streams e não MariaDB?** 
  - Logs de auditoria possuem um padrão de uso com **alta taxa de escrita** e **leituras eventuais**, dispensando joins ou transações relacionais complexas.
  - O **Redis Streams** foi escolhido pois já fornece ordenação cronológica nativa por ID temporal (`<timestamp>-<seq>`), suporta comandos como `XADD` (inserção em O(1)) e `XREVRANGE` (leitura cronológica inversa), além de `XDEL` para remoção pontual.

### 2. Estrutura dos Eventos Gravados
Cada registro enviado via `POST /logs` armazena:
- `usuario_id`: ID numérico do usuário ou `'anonimo'`
- `acao`: Identificador da ação (ex: `login_sucesso`, `favoritar_filme`, `tentativa_negada_403`, etc.)
- `detalhes`: Contexto em texto sobre o evento
- `ip`: IP de origem da requisição extraído via headers/socket
- `data_hora`: Timestamp ISO gerado automaticamente no momento da inserção

### 3. Eventos Rastreados no Sistema
- **Autenticação (`auth-service`):**
  - Login com sucesso (`login_sucesso`) e falhas de senha (`login_falha`)
  - Logout (`logout`)
  - Novo cadastro (`registro_usuario`)
  - Solicitação e redefinição de senha (`solicitacao_reset_senha`, `redefinicao_senha`)
- **Catálogo e Interações (`catalogo-service`):**
  - Favoritar e desfavoritar filmes (`favoritar_filme`, `desfavoritar_filme`)
  - Publicação de comentários (`comentar_filme`)
  - Exclusão do próprio comentário (`apagar_comentario_proprio`)
- **Segurança e Moderação:**
  - Moderação de comentários por admin (`moderar_comentario`)
  - **Tentativas negadas de acesso 403 (`tentativa_negada_403`)**: Tentativas de usuários comuns acessando rotas de administração.
  - Exclusão de logs de auditoria (`deletar_log`)

### 4. Controle de Acesso e Consulta (RBAC)
- A consulta aos logs é feita pela rota `GET /api/logs?limit=100` no `catalogo-service`, que repassa internamente para o `log-service`.
- Esta rota é protegida pelo `adminMiddleware`. Usuários sem o papel `admin` recebem **HTTP 403** (e a própria tentativa gera um log de auditoria de segurança).
- O painel web conta com uma aba dedicada ("Logs de Auditoria (Redis)") no modal de Administrador para visualização e gerenciamento dos eventos.

### 5. Roteiro para Demonstração
1. Subir os serviços com `docker-compose up --build -d`.
2. Fazer login com um usuário comum.
3. Favoritar um filme e adicionar um comentário.
4. Tentar forçar o acesso a uma rota de admin (ex: tentar bater direto no endpoint `/api/logs` via navegador/Postman sem ser admin para gerar o erro 403).
5. Deslogar e entrar com a conta de **Administrador**.
6. Abrir o **Painel do Administrador** -> aba **Logs de Auditoria (Redis)** e verificar todos os eventos registrados em ordem cronológica com seus respectivos IDs do Redis, IPs e detalhes.

## 6. Estratégia de Retorno da Imagem (MinIO Object Storage)

**Decisão Adotada:** Implementação de um Bucket com Leitura Pública.

**Explicação e Trade-offs:** 
Para a funcionalidade de foto de perfil (que possui um caráter de rede social nesta aplicação), optou-se por configurar o bucket do MinIO com políticas de leitura pública (*Public Read*). 

- **Vantagem:** O banco de dados (MariaDB) guarda diretamente a URL final e limpa da imagem. O frontend não precisa fazer múltiplas requisições adicionais ao backend para gerar *Pre-signed URLs* a cada vez que o avatar for renderizado no cabeçalho ou em uma lista de comentários, melhorando drasticamente a performance, a latência do cliente e permitindo cache otimizado no navegador.
- **Trade-off (Desvantagem):** Qualquer pessoa que possua a URL exata do objeto no MinIO pode acessar a foto, mesmo sem estar logada. Dado o contexto de uma foto de perfil, essa redução de privacidade é um padrão aceitável e utilizado na maioria das redes sociais (ex: imagens de perfil do GitHub ou Instagram não requerem autenticação para carregar o binário da imagem na tag `<img>`), priorizando assim o desempenho e a escalabilidade.

**Relatório Completo em PDF:** [Clique aqui para abrir o Relatório em PDF](./docs/P1_ISW055_Yago_Martins.pdf)
