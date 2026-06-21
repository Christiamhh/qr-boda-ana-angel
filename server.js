import app from './api/index.js';

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  Boda Ana & Ángel — servidor local en http://localhost:${PORT}`);
  console.log(`  Páginas: /ceremonia  /recepcion  /galeria  /qr`);
  console.log(`  Almacenamiento: Vercel Blob (${process.env.BLOB_READ_WRITE_TOKEN ? 'conectado' : 'SIN token'})\n`);
});
