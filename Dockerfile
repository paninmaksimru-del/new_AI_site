# Платформа внедрения ИИ инструментов (Фонд МИК)
FROM node:20-alpine

WORKDIR /app

# зависимости
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# код сервера и статика
COPY server ./server
COPY public ./public
COPY prompt-library.json ./

# данные SQLite будут в volume; нестандартный порт для ограниченной инфраструктуры
ENV NODE_ENV=production
ENV PORT=19080

EXPOSE 19080

CMD ["node", "server/index.js"]
