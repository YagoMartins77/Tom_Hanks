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