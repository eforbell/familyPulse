'use strict';

const { types } = require('pg');

// Explicit data-only projections: never export items.*, members.*, configuration,
// credentials, or attachment storage paths. Keep transaction amounts one per row.
const TRANSACTION_COLUMNS = `id plaid_transaction_id account_id amount date authorized_date
  merchant_name name plaid_category category_id pending iso_currency_code is_transfer
  transfer_type transfer_pair_id source raw_json created_at updated_at is_hidden
  hidden_reason duplicate_of_transaction_id dedup_run_id source_removed source_removed_at
  display_name_override display_name_override_updated_by display_name_override_updated_at
  merchant_fingerprint categorization_source suggested_category_id suggestion_source`.split(/\s+/);

const columns = (alias, names) => names.map(name => `${alias}.${name}`).join(', ');

const ALLOCATIONS_SQL = `SELECT ta.id, ta.transaction_id, ta.category_id, ta.amount, ta.position,
  ta.created_by, ta.created_at, ta.updated_at, c.name AS category_name, c.is_income,
  c.is_transfer_class, c.exclude_from_spending, m.name AS created_by_name
  FROM transaction_allocations ta
  LEFT JOIN categories c ON c.id = ta.category_id
  LEFT JOIN family_members m ON m.id = ta.created_by`;

const ATTACHMENTS_SQL = `SELECT att.id, att.transaction_id, att.original_filename,
  att.mime_type, att.byte_size, att.uploaded_by, m.name AS uploaded_by_name, att.created_at
  FROM transaction_attachments att LEFT JOIN family_members m ON m.id = att.uploaded_by`;

const PAYCHECKS_SQL = `SELECT pe.id, pe.member_id, m.name AS member_name, pe.employer, pe.pay_date,
  pe.gross_earnings, pe.federal_tax, pe.social_security_tax, pe.medicare_tax,
  pe.retirement_401k, pe.health_insurance, pe.other_deductions, pe.total_net_amount,
  pe.created_by, creator.name AS created_by_name, pe.created_at, pe.updated_at
  FROM paycheck_events pe
  LEFT JOIN family_members m ON m.id = pe.member_id
  LEFT JOIN family_members creator ON creator.id = pe.created_by`;

const DEPOSITS_SQL = `SELECT pd.id, pd.paycheck_event_id, pd.transaction_id, pd.gross_attribution,
  pd.deductions_applied, pd.source_net_amount, pd.reconciliation_status, pd.position,
  pd.created_at, pd.updated_at FROM paycheck_deposits pd`;

const RECURRING_HISTORY_SQL = `SELECT rh.id, rh.recurring_expense_id, rh.transaction_id,
  rh.amount, rh.transaction_date, rh.created_at, re.merchant_name, re.cashflow_type,
  re.frequency, re.status FROM recurring_expense_history rh
  LEFT JOIN recurring_expenses re ON re.id = rh.recurring_expense_id`;

const TRANSACTIONS_SQL = `SELECT ${columns('t', TRANSACTION_COLUMNS)},
  COALESCE(NULLIF(t.display_name_override, ''), NULLIF(t.merchant_name, ''), t.name) AS display_name,
  a.name AS account_name, COALESCE(a.custom_name, a.name) AS account_display_name,
  a.official_name AS account_official_name, a.type AS account_type, a.subtype AS account_subtype,
  a.mask AS account_mask, a.owner AS account_owner, a.sync_status AS account_sync_status,
  i.institution_name, i.status AS institution_status,
  legacy.name AS legacy_category_name, suggested.name AS suggested_category_name,
  override_member.name AS display_name_override_updated_by_name,
  n.note, n.created_at AS note_created_at, n.updated_at AS note_updated_at,
  note_creator.name AS note_created_by_name, note_editor.name AS note_updated_by_name,
  COALESCE((SELECT jsonb_agg(to_jsonb(allocation) ORDER BY allocation.position, allocation.id)
    FROM (${ALLOCATIONS_SQL}) allocation WHERE allocation.transaction_id = t.id), '[]'::jsonb) AS allocations,
  COALESCE((SELECT jsonb_agg(to_jsonb(attachment) ORDER BY attachment.id)
    FROM (${ATTACHMENTS_SQL}) attachment WHERE attachment.transaction_id = t.id), '[]'::jsonb) AS attachments,
  COALESCE((SELECT jsonb_agg(to_jsonb(history) ORDER BY history.id)
    FROM (${RECURRING_HISTORY_SQL}) history WHERE history.transaction_id = t.id), '[]'::jsonb) AS recurring_matches,
  (SELECT to_jsonb(deposit) FROM (${DEPOSITS_SQL}) deposit WHERE deposit.transaction_id = t.id) AS paycheck_deposit,
  (SELECT to_jsonb(paycheck) FROM (${PAYCHECKS_SQL}) paycheck
    JOIN paycheck_deposits pd ON pd.paycheck_event_id = paycheck.id WHERE pd.transaction_id = t.id) AS paycheck
  FROM transactions t
  LEFT JOIN accounts a ON a.id = t.account_id
  LEFT JOIN items i ON i.id = a.item_id
  LEFT JOIN categories legacy ON legacy.id = t.category_id
  LEFT JOIN categories suggested ON suggested.id = t.suggested_category_id
  LEFT JOIN family_members override_member ON override_member.id = t.display_name_override_updated_by
  LEFT JOIN transaction_notes n ON n.transaction_id = t.id
  LEFT JOIN family_members note_creator ON note_creator.id = n.created_by
  LEFT JOIN family_members note_editor ON note_editor.id = n.updated_by
  ORDER BY t.date, t.id`;

const exportTypes = {
  // A SQL DATE is a calendar date, not midnight in the server's timezone.
  getTypeParser(oid, format) {
    return oid === 1082 ? value => value : types.getTypeParser(oid, format);
  }
};

async function withExportSnapshot(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function* readDataset(client, dataset) {
  await client.query(`DECLARE export_rows NO SCROLL CURSOR FOR ${dataset.sql}`);
  let failed = false;
  try {
    let batch;
    do {
      batch = await client.query({ text: 'FETCH FORWARD 500 FROM export_rows', types: exportTypes });
      yield batch;
    } while (batch.rows.length === 500);
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    if (!failed) await client.query('CLOSE export_rows');
  }
}

function textValue(value) {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

const NUMERIC_OIDS = new Set([20, 21, 23, 700, 701, 1700]);

function csvCell(value, field) {
  let text = textValue(value);
  // Only database-typed numbers may start with a minus/plus unescaped. Untrusted
  // text (including leading whitespace and full-width initiators) stays inert.
  if (!NUMERIC_OIDS.has(field?.dataTypeID) && /^[\s\u0000-\u001f]*[=+\-@＝＋－＠\t\r\n]/u.test(text)) {
    text = `'${text}`;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

async function writeCsv(client, writable) {
  const { Readable } = require('node:stream');
  const { pipeline } = require('node:stream/promises');
  async function* lines() {
    let headersWritten = false;
    yield '\uFEFF';
    for await (const { fields, rows } of readDataset(client, { sql: TRANSACTIONS_SQL })) {
      if (!headersWritten) {
        yield fields.map(field => csvCell(field.name)).join(',') + '\r\n';
        headersWritten = true;
      }
      for (const row of rows) {
        yield fields.map(field => csvCell(row[field.name], field)).join(',') + '\r\n';
      }
    }
  }
  await pipeline(Readable.from(lines()), writable);
}

module.exports = { readDataset, withExportSnapshot, textValue, csvCell, writeCsv };
