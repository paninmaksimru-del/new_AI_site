/**
 * Локальный превью статики из /public без PostgreSQL.
 * Откройте: http://localhost:5050/cases.html
 */
import express from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', 'public');
const port = Number(process.env.PREVIEW_PORT) || 5050;

const app = express();
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use(express.static(publicDir, { index: false }));

app.listen(port, () => {
  console.log(`Preview (static): http://localhost:${port}/cases.html`);
  console.log('Без БД: /api/* недоступны — на странице кейсов сработает встроенный fallback.');
});
