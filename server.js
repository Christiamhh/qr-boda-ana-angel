import app from './api/index.js';
import { STORAGE_MODE, PUBLIC_BASE_URL } from './lib/config.js';
import { dbMode } from './lib/db.js';

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  Boda Ana & Ángel — servidor local`);
  console.log(`  → ${PUBLIC_BASE_URL}`);
  console.log(`  Almacenamiento: ${STORAGE_MODE}   Base de datos: ${dbMode}`);
  console.log(`  Páginas: /ceremonia  /recepcion  /galeria  /qr\n`);
});
