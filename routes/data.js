const express = require('express');
const bcrypt = require('bcryptjs');
const auth = require('../middleware/auth');
const pool = require('../db/pool');

const router = express.Router();

const divisions = {
  founder: ['patent', 'trademark', 'copyright', 'design', 'notice'],
  coo: ['patent', 'trademark', 'copyright', 'design', 'notice'],
  biz_head: ['patent', 'trademark', 'copyright', 'design', 'notice'],
  patent_head: ['patent'],
  tm_head: ['trademark', 'copyright', 'design'],
  accounts: [],
  patent_paralegal: ['patent'],
  tm_associate: ['trademark', 'copyright', 'design'],
  tm_paralegal: ['trademark'],
  comms: ['notice', 'copyright', 'design'],
};
const allMattersRoles = ['founder', 'coo', 'biz_head'];
const billingRoles = ['founder', 'coo', 'biz_head', 'accounts'];
const adminRoles = ['founder', 'coo'];

const fields = {
  clients: {
    table: 'clients',
    columns: columnMap('name email phone type city source gstin createdAt'),
  },
  matters: {
    table: 'matters',
    columns: columnMap(`matterId type clientId clientName title status stage intakeStage assignedLead dateOpened paymentStatus totalFee govtFee notes applicationNo priorityDate filingDate jurisdiction applicationType route applicantCategory ferReceivedDate ferResponseDeadline rfeDeadline grantDate patentNumber annuityYear3Due niceClass markType feeOption examReportDate objectionReplyDeadline objectionReplyFiled hearingDate publicationDate oppositionReceived oppositionDate counterStatementDeadline counterStatementFiled registrationDate registrationNumber renewalDueDate workType authorName diaryNo waitingPeriodEnd designClass noticeType oppositeParty oppositePartyAddress oppositePartyEmail dispatchDate speedPostId deliveryDate responseDueDate statutoryLimitation outcome createdAt`),
  },
  invoices: {
    table: 'invoices',
    columns: { ...columnMap('invoiceNo billNo financialYear matterId clientId clientName practiceArea description amount govtFee outOfPocket total amountReceived balanceDue status paidDate method remark addedBy createdAt'), date: 'invoice_date' },
  },
  renewals: {
    table: 'renewals',
    columns: columnMap('type clientName matterId matterTitle patentNo appNo dueDate year amount status alertSent createdAt'),
  },
  users: {
    table: 'users',
    columns: columnMap('name email role avatar'),
  },
};
const children = {
  tasks: { table: 'tasks', columns: columnMap('matterId name assignedTo assignedBy assignedDate dueDate done doneDate daysToComplete note') },
  communications: { table: 'communications', columns: { ...columnMap('matterId type text'), date: 'comm_date', by: 'logged_by' } },
  documents: { table: 'documents', columns: { ...columnMap('matterId name uploadedBy filePath'), date: 'upload_date' } },
};

function columnMap(names) {
  return Object.fromEntries(names.split(/\s+/).filter(Boolean).map((name) => [
    name,
    name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
  ]));
}

function camelRow(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()),
    value,
  ]));
}

function asTime(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

function valuesMatch(row, mapped, originalFields) {
  return Promise.all(mapped.map(async ({ column, value, key }) => {
    if (key === 'password') return bcrypt.compare(String(value), row.password_hash);
    const current = row[column];
    if (current instanceof Date || value instanceof Date) {
      return asTime(current) === asTime(value);
    }
    if (current == null || value == null) return current == null && value == null;
    return String(current) === String(value);
  })).then((matches) => matches.every(Boolean));
}

function mapInput(config, input) {
  return Object.entries(input || {}).flatMap(([key, value]) => {
    if (key === 'password' && config.table === 'users') return [{ column: 'password_hash', value, key }];
    const column = config.columns[key];
    return column ? [{ column, value, key }] : [];
  });
}

async function syncRow(db, config, record, expectedUpdatedAt) {
  if (!record || typeof record.id !== 'string' || !record.id) {
    throw Object.assign(new Error('Each synced record requires an id'), { status: 400 });
  }

  const mapped = mapInput(config, record.fields);
  const originalFields = record.fields || {};
  if (config.table === 'users') {
    const password = mapped.find((field) => field.key === 'password');
    if (password) password.value = await bcrypt.hash(String(password.value), 10);
  }

  const existing = await db.query(`SELECT * FROM ${config.table} WHERE id=$1 FOR UPDATE`, [record.id]);
  if (existing.rows.length && expectedUpdatedAt && existing.rows[0].updated_at) {
    const currentTime = asTime(existing.rows[0].updated_at);
    const expectedTime = asTime(expectedUpdatedAt);
    if (currentTime !== expectedTime && !(await valuesMatch(existing.rows[0], mapped, originalFields))) {
      throw Object.assign(new Error(`This ${config.table} record changed elsewhere. Reload before retrying.`), { status: 409 });
    }
  }

  if (!mapped.length) return existing.rows[0] || null;

  const columns = ['id', ...mapped.map((field) => field.column)];
  const params = [record.id, ...mapped.map((field) => field.value)];
  const placeholders = params.map((_, index) => `$${index + 1}`);

  if (existing.rows.length) {
    const assignments = mapped.map((field, index) => `${field.column}=$${index + 2}`);
    const result = await db.query(
      `UPDATE ${config.table} SET ${assignments.join(', ')} WHERE id=$1 RETURNING *`,
      params,
    );
    return result.rows[0];
  }

  const result = await db.query(
    `INSERT INTO ${config.table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
    params,
  );
  return result.rows[0];
}

async function assertMatterAccess(db, role, matterId, incomingType) {
  if (allMattersRoles.includes(role)) return;
  const allowed = divisions[role] || [];
  const type = incomingType || (await db.query('SELECT type FROM matters WHERE id=$1', [matterId])).rows[0]?.type;
  if (!allowed.includes(type)) {
    throw Object.assign(new Error('Access denied for this matter'), { status: 403 });
  }
}

router.get('/bootstrap', auth, async (req, res) => {
  try {
    const [userRows, clientRows, matterRows, renewalRows] = await Promise.all([
      pool.query('SELECT id,name,email,role,avatar,created_at,updated_at FROM users ORDER BY name'),
      pool.query('SELECT * FROM clients ORDER BY name'),
      allMattersRoles.includes(req.user.role)
        ? pool.query('SELECT * FROM matters ORDER BY date_opened DESC')
        : (divisions[req.user.role] || []).length
          ? pool.query('SELECT * FROM matters WHERE type=ANY($1) ORDER BY date_opened DESC', [divisions[req.user.role]])
          : Promise.resolve({ rows: [] }),
      pool.query('SELECT * FROM renewals ORDER BY due_date'),
    ]);

    const matters = matterRows.rows.map(camelRow);
    const matterIds = matters.map((matter) => matter.id);
    const [taskRows, communicationRows, documentRows] = matterIds.length
      ? await Promise.all([
        pool.query('SELECT * FROM tasks WHERE matter_id=ANY($1) ORDER BY created_at', [matterIds]),
        pool.query('SELECT * FROM communications WHERE matter_id=ANY($1) ORDER BY comm_date DESC', [matterIds]),
        pool.query('SELECT * FROM documents WHERE matter_id=ANY($1) ORDER BY upload_date DESC', [matterIds]),
      ])
      : [{ rows: [] }, { rows: [] }, { rows: [] }];

    const byMatter = (rows, transform = camelRow) => {
      const grouped = new Map();
      for (const row of rows) {
        const value = transform(row);
        const list = grouped.get(row.matter_id) || [];
        list.push(value);
        grouped.set(row.matter_id, list);
      }
      return grouped;
    };
    const tasks = byMatter(taskRows.rows);
    const communications = byMatter(communicationRows.rows, (row) => ({
      id: row.id, type: row.type, date: row.comm_date, text: row.text, by: row.logged_by,
    }));
    const documents = byMatter(documentRows.rows, (row) => ({
      id: row.id, name: row.name, uploadedBy: row.uploaded_by, date: row.upload_date, filePath: row.file_path,
    }));
    for (const matter of matters) {
      matter.tasks = tasks.get(matter.id) || [];
      matter.communications = communications.get(matter.id) || [];
      matter.documents = documents.get(matter.id) || [];
    }

    const invoices = billingRoles.includes(req.user.role)
      ? (await pool.query('SELECT * FROM invoices ORDER BY invoice_date DESC')).rows.map((row) => {
        const invoice = camelRow(row);
        invoice.date = invoice.invoiceDate;
        delete invoice.invoiceDate;
        return invoice;
      })
      : [];

    res.json({
      users: userRows.rows.map(camelRow),
      clients: clientRows.rows.map(camelRow),
      matters,
      invoices,
      renewals: renewalRows.rows.map(camelRow),
    });
  } catch (err) {
    res.status(500).json({ error: 'Could not load CRM data', message: err.message });
  }
});

router.post('/sync', auth, async (req, res) => {
  const { entity, records } = req.body || {};
  const config = fields[entity];
  if (!config || !Array.isArray(records) || records.length > 2500) {
    return res.status(400).json({ error: 'Invalid sync request' });
  }
  if (entity === 'invoices' && !billingRoles.includes(req.user.role)) {
    return res.status(403).json({ error: 'Billing access denied' });
  }
  if (entity === 'users' && !adminRoles.includes(req.user.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const results = [];
    for (const record of records) {
      if (entity === 'matters') {
        await assertMatterAccess(db, req.user.role, record.id, record.fields?.type);
      }
      const row = await syncRow(db, config, record, record.expectedUpdatedAt);
      const childResults = {};

      if (entity === 'matters') {
        for (const [key, childConfig] of Object.entries(children)) {
          childResults[key] = [];
          for (const child of record[key] || []) {
            const childRow = await syncRow(db, childConfig, {
              id: child.id,
              fields: { ...child.fields, matterId: record.id },
            }, child.expectedUpdatedAt);
            childResults[key].push({ id: child.id, updatedAt: childRow?.updated_at || null });
          }
        }
      }

      results.push({ id: record.id, updatedAt: row?.updated_at || null, children: childResults });
    }
    await db.query('COMMIT');
    res.json({ ok: true, entity, results });
  } catch (err) {
    await db.query('ROLLBACK');
    res.status(err.status || 500).json({ error: err.message || 'Sync failed' });
  } finally {
    db.release();
  }
});

module.exports = router;