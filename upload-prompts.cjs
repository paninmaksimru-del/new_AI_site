/**
 * upload-prompts.cjs
 * Загружает промпты из "prompt-library copy.json" в API сайта.
 *
 * Использование:
 *   node upload-prompts.cjs [BASE_URL]
 *
 * Пример:
 *   node upload-prompts.cjs http://localhost:3000
 *
 * По умолчанию BASE_URL = http://localhost:3000
 */

const fs   = require('fs');
const http = require('http');
const https = require('https');

const BASE_URL = process.argv[2] || 'http://localhost:3000';
const FILE     = 'prompt-library copy.json';

// ── Читаем JSON ──────────────────────────────────────────────────────────────
const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));

// ── Конвертируем в плоский массив для API ────────────────────────────────────
// Формат API: { id, sectionTitle, sectionSubtitle, title, meta, text, result }
const flat = [];
data.categories.forEach(cat => {
  cat.prompts.forEach(p => {
    flat.push({
      id:              cat.id + '_' + p.id,
      sectionTitle:    cat.name,
      sectionSubtitle: cat.description || '',
      title:           p.title,
      meta:            p.description || '',   // подзаголовок промпта
      text:            p.prompt || '',         // текст промпта
      result:          p.result || ''
    });
  });
});

console.log('Промптов для загрузки:', flat.length);

// ── Отправляем PUT /api/prompts ──────────────────────────────────────────────
const body   = JSON.stringify(flat);
const url    = new URL('/api/prompts', BASE_URL);
const client = url.protocol === 'https:' ? https : http;

const options = {
  hostname: url.hostname,
  port:     url.port || (url.protocol === 'https:' ? 443 : 80),
  path:     url.pathname,
  method:   'PUT',
  headers:  {
    'Content-Type':   'application/json',
    'Content-Length': Buffer.byteLength(body)
  }
};

const req = client.request(options, res => {
  let raw = '';
  res.on('data', chunk => raw += chunk);
  res.on('end', () => {
    if (res.statusCode === 200) {
      const result = JSON.parse(raw);
      console.log('Успешно загружено промптов:', result.length);
    } else {
      console.error('Ошибка сервера:', res.statusCode, raw);
    }
  });
});

req.on('error', err => console.error('Ошибка соединения:', err.message));
req.write(body);
req.end();
