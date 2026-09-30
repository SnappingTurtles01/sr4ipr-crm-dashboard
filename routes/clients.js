// routes/clients.js
const express = require('express');
const router  = express.Router();
const auth    = require('../middleware/auth');
const pool    = require('../db/pool');

router.get('/', auth, async (req, res) => {
  const { search, type, source, page=1, limit=100 } = req.query;
  let where = [], params = [], idx = 1;
  if (search) {
    where.push(`(LOWER(name) LIKE $${idx} OR LOWER(email) LIKE $${idx} OR LOWER(city) LIKE $${idx})`);
    params.push('%'+search.toLowerCase()+'%'); idx++;
  }
  if (type)   { where.push(`type=$${idx++}`);   params.push(type); }
  if (source) { where.push(`source=$${idx++}`); params.push(source); }
  const sql = `SELECT * FROM clients ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY name LIMIT $${idx} OFFSET $${idx+1}`;
  const result = await pool.query(sql, [...params, limit, (page-1)*limit]);
  res.json(result.rows);
});

router.get('/:id', auth, async (req, res) => {
  const c = await pool.query('SELECT * FROM clients WHERE id=$1', [req.params.id]);
  if (!c.rows.length) return res.status(404).json({error:'Not found'});
  const matters = await pool.query('SELECT id,matter_id,title,type,stage,status FROM matters WHERE client_id=$1', [req.params.id]);
  res.json({...c.rows[0], matters: matters.rows});
});

router.post('/', auth, async (req, res) => {
  const c = req.body;
  const id = 'c'+Date.now();
  const result = await pool.query(
    'INSERT INTO clients (id,name,email,phone,type,city,source,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
    [id,c.name,c.email||'',c.phone||'',c.type||'individual',c.city||'',c.source||'Referral',new Date().toISOString().split('T')[0]]
  );
  res.status(201).json(result.rows[0]);
});

router.post('/merge', auth, async (req, res) => {
  const { keepId, deleteId, keepName } = req.body || {};
  if (!keepId || !deleteId || keepId === deleteId)
    return res.status(400).json({ error: 'Two different client IDs are required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query(
      'SELECT id,name FROM clients WHERE id=ANY($1) ORDER BY id FOR UPDATE',
      [[keepId, deleteId]],
    );
    const keeper = selected.rows.find((row) => row.id === keepId);
    const duplicate = selected.rows.find((row) => row.id === deleteId);
    if (!keeper || !duplicate) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'One or both clients no longer exist' });
    }

    const name = (keepName || keeper.name).trim();
    await client.query('UPDATE clients SET name=$1 WHERE id=$2', [name, keepId]);
    await client.query('UPDATE matters SET client_id=$1,client_name=$2 WHERE client_id=$3', [keepId, name, deleteId]);
    await client.query('UPDATE invoices SET client_id=$1 WHERE client_id=$2', [keepId, deleteId]);
    await client.query('UPDATE renewals SET client_name=$1 WHERE client_name=$2', [name, duplicate.name]);
    await client.query('DELETE FROM clients WHERE id=$1', [deleteId]);
    await client.query('COMMIT');
    res.json({ ok: true, keepId, deleteId, name });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
