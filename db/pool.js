require('dotenv').config();
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL must be set before starting the application');
}

module.exports = new Pool({ connectionString: process.env.DATABASE_URL });