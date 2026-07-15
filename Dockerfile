# Платформа внедрения ИИ инструментов (Фонд МИК)
FROM node:20-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app

# зависимости
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# код сервера и статика
COPY server ./server
COPY public ./public

# PostgreSQL подключается через DATABASE_URL; нестандартный порт для инфраструктуры
ENV NODE_ENV=production
ENV PORT=19080

EXPOSE 19080

CMD ["node", "server/index.js"]
