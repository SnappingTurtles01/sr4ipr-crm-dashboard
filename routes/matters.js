// routes/matters.js — Matter CRUD with role-based access

const express = require('express');
const router  = express.Router();
const { Pool } = require('pg');
const auth    = require('../middleware/auth');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Role → allowed divisions map
const ROLE_DIVISIONS = {
  founder:          ['patent','trademark','copyright','design','notice'],
  coo:              ['patent','trademark','copyright','design','notice'],
  biz_head:         ['patent','trademark','copyright','design','notice'],
  patent_head:      ['patent'],
  tm_head:          ['trademark','copyright','design'],
  accounts:         [],
  patent_paralegal: ['patent'],
  tm_associate:     ['trademark','copyright','design'],
  tm_paralegal:     ['trademark'],
  comms:            ['notice','copyright','design'],
};

function canSeeAllMatters(role) {
  return ['founder','coo','biz_head'].includes(role);
}

// GET /api/matters — list with filters
router.get('/', auth, async (req, res) => {
  try {
    const { type, status, search, page = 1, limit = 100 } = req.query;
    const allowed = ROLE_DIVISIONS[req.user.role] || [];
    const seeAll  = canSeeAllMatters(req.user.role);

    let where = [];
    let params = [];
    let idx = 1;

    if (!seeAll) {
      if (!allowed.length) return res.json({ matters: [], total: 0 });
      where.push(`type = ANY($${idx++})`);
      params.push(allowed);
    }

    if (type) { where.push(`type = $${idx++}`); params.push(type); }
    if (status) { where.push(`status = $${idx++}`); params.push(status); }
    if (search) {
      where.push(`(LOWER(title) LIKE $${idx} OR LOWER(client_name) LIKE $${idx} OR LOWER(matter_id) LIKE $${idx})`);
      params.push(`%${search.toLowerCase()}%`); idx++;
    }

    const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const offset   = (page - 1) * limit;

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM matters ${whereSQL}`, params
    );
    const total = parseInt(countResult.rows[0].count);

    const result = await pool.query(
      `SELECT * FROM matters ${whereSQL} ORDER BY date_opened DESC LIMIT $${idx} OFFSET $${idx+1}`,
      [...params, limit, offset]
    );

    res.json({ matters: result.rows, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/matters/:id — single matter with tasks + comms + docs
router.get('/:id', auth, async (req, res) => {
  try {
    const matter = await pool.query('SELECT * FROM matters WHERE id = $1', [req.params.id]);
    if (!matter.rows.length) return res.status(404).json({ error: 'Matter not found' });

    const m = matter.rows[0];
    const allowed = ROLE_DIVISIONS[req.user.role] || [];
    if (!canSeeAllMatters(req.user.role) && !allowed.includes(m.type))
      return res.status(403).json({ error: 'Access denied' });

    const tasks = await pool.query(
      'SELECT * FROM tasks WHERE matter_id = $1 ORDER BY created_at', [req.params.id]
    );
    const comms = await pool.query(
      'SELECT * FROM communications WHERE matter_id = $1 ORDER BY comm_date DESC', [req.params.id]
    );
    const docs = await pool.query(
      'SELECT * FROM documents WHERE matter_id = $1 ORDER BY upload_date DESC', [req.params.id]
    );

    res.json({ ...m, tasks: tasks.rows, communications: comms.rows, documents: docs.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/matters — create new matter
router.post('/', auth, async (req, res) => {
  const m = req.body;
  try {
    const result = await pool.query(`
      INSERT INTO matters (
        id, matter_id, type, client_id, client_name, title, status, stage,
        intake_stage, assigned_lead, date_opened, payment_status, total_fee, govt_fee, notes,
        application_no, priority_date, filing_date, jurisdiction
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      RETURNING *
    `, [
      m.id, m.matterId, m.type, m.clientId, m.clientName, m.title,
      m.status||'active', m.stage, m.intakeStage||m.stage, m.assignedLead,
      m.dateOpened||new Date().toISOString().split('T')[0],
      m.paymentStatus||'pending', m.totalFee||0, m.govtFee||0, m.notes||'',
      m.applicationNo||null, m.priorityDate||null, m.filingDate||null, m.jurisdiction||null
    ]);

    // Insert default tasks
    for (const t of (m.tasks || [])) {
      await pool.query(`
        INSERT INTO tasks (id, matter_id, name, assigned_to, assigned_by, assigned_date, due_date)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
      `, [t.id+'_'+m.id, m.id, t.name, t.assignedTo||'', t.assignedBy||req.user.name,
          t.assignedDate||new Date().toISOString().split('T')[0], t.dueDate||null]);
    }

    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/matters/:id — update stage, status, payment
router.patch('/:id', auth, async (req, res) => {
  const updates = req.body;
  try {
    const fields = Object.keys(updates)
      .filter(k => ['stage','status','payment_status','notes','assigned_lead',
                    'fer_response_deadline','objection_reply_deadline',
                    'counter_statement_deadline','response_due_date','speed_post_id'].includes(k))
      .map((k, i) => `${k} = $${i+2}`)
      .join(', ');

    if (!fields) return res.status(400).json({ error: 'No valid fields to update' });

    const values = Object.keys(updates)
      .filter(k => ['stage','status','payment_status','notes','assigned_lead',
                    'fer_response_deadline','objection_reply_deadline',
                    'counter_statement_deadline','response_due_date','speed_post_id'].includes(k))
      .map(k => updates[k]);

    const result = await pool.query(
      `UPDATE matters SET ${fields} WHERE id = $1 RETURNING *`,
      [req.params.id, ...values]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
