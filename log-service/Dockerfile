# Usa uma imagem leve do Node.js
FROM node:18-alpine

# Define o diretório de trabalho dentro do container
WORKDIR /usr/src/app

# Copia os arquivos de dependência primeiro
COPY package*.json ./

# Instala as dependências
RUN npm install

# Copia o restante do código (o seu index.js)
COPY . .

# Expõe a porta que o serviço vai usar internamente
EXPOSE 3002

# Comando para iniciar o serviço
CMD ["npm", "start"]