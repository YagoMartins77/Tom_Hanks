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