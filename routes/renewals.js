// routes/renewals.js
const express = require('express');
const router  = express.Router();
const { Pool } = require('pg');
const auth    = require('../middleware/auth');
const pool    = new Pool({ connectionString: process.env.DATABASE_URL });

router.get('/', auth, async (req, res) => {
  const { type, urgency } = req.query;
  let where=[], params=[], idx=1;
  if (type) { where.push(`type=$${idx++}`); params.push(type); }
  if (urgency) {
    where.push(`due_date <= CURRENT_DATE + INTERVAL '${parseInt(urgency)} days'`);
  }
  const sql = `SELECT * FROM renewals ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY due_date ASC`;
  const result = await pool.query(sql, params);
  res.json(result.rows);
});

router.patch('/:id', auth, async (req, res) => {
  const { status, alertSent } = req.body;
  const result = await pool.query(
    'UPDATE renewals SET status=$1, alert_sent=$2 WHERE id=$3 RETURNING *',
    [status||'pending', alertSent||false, req.params.id]
  );
  res.json(result.rows[0]);
});

module.exports = router;
