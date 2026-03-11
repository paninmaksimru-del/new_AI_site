import { getDb } from './db.js';
import './seed.js';

getDb();
console.log('DB initialized. Run npm start to start the server.');
