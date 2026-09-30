require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('./pool');

async function applySchema() {
  try {
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await pool.query(schema);
    console.log('Database schema applied successfully');
  } finally {
    await pool.end();
  }
}

applySchema().catch((err) => {
  console.error('Schema setup failed:', err.message);
  process.exitCode = 1;
});