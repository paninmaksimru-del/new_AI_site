import { initSchema } from './db.js';
import './seed.js';

await initSchema();
console.log('DB initialized. Run npm start to start the server.');
