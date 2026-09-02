'use strict';

// This is a payload/abuse guard, not a household product limit. The browser
// editor adds rows progressively and does not advertise a fixed split cap.
const MAX_ALLOCATIONS_PER_TRANSACTION = 24;

function moneyToCents(value) {
  const raw = String(value ?? '').trim();
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(raw)) {
    throw Object.assign(new Error('Allocation amounts must use at most two decimal places'), { status: 400 });
  }
  const negative = raw.startsWith('-');
  const unsigned = negative ? raw.slice(1) : raw;
  const [whole, fraction = ''] = unsigned.split('.');
  const cents = (BigInt(whole) * 100n) + BigInt(fraction.padEnd(2, '0'));
  return negative ? -cents : cents;
}

function centsToMoney(cents) {
  const value = BigInt(cents);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

function normalizeAllocationInput(allocations) {
  if (!Array.isArray(allocations) || allocations.length === 0) {
    throw Object.assign(new Error('At least one allocation is required'), { status: 400 });
  }
  if (allocations.length > MAX_ALLOCATIONS_PER_TRANSACTION) {
    throw Object.assign(new Error(`Maximum ${MAX_ALLOCATIONS_PER_TRANSACTION} allocations per transaction`), { status: 400 });
  }

  const categoryIds = new Set();
  let uncategorizedAdjustmentCount = 0;
  return allocations.map((allocation, index) => {
    const categoryId = allocation.category_id == null ? null : Number(allocation.category_id);
    if (categoryId !== null && (!Number.isInteger(categoryId) || categoryId <= 0)) {
      throw Object.assign(new Error('Each allocation requires a valid category'), { status: 400 });
    }
    if (categoryId === null) {
      uncategorizedAdjustmentCount += 1;
      if (uncategorizedAdjustmentCount > 1) {
        throw Object.assign(new Error('A split can contain at most one uncategorized adjustment'), { status: 400 });
      }
    } else {
      if (categoryIds.has(categoryId)) {
        throw Object.assign(new Error('A category can only appear once in a transaction split'), { status: 400 });
      }
      categoryIds.add(categoryId);
    }

    const cents = moneyToCents(allocation.amount);
    if (cents === 0n && allocations.length > 1) {
      throw Object.assign(new Error('Split allocation amounts must be non-zero'), { status: 400 });
    }
    return { categoryId, cents, position: index + 1 };
  });
}

async function getTransactionAllocations(client, transactionId) {
  const { rows } = await client.query(
    `SELECT ta.id, ta.transaction_id, ta.category_id, ta.amount, ta.position,
            c.name AS category_name, c.color AS category_color, c.icon AS category_icon,
            c.is_income, c.is_transfer_class
     FROM transaction_allocations ta
     LEFT JOIN categories c ON c.id = ta.category_id
     WHERE ta.transaction_id = $1
     ORDER BY ta.position, ta.id`,
    [transactionId]
  );
  return rows;
}

async function replaceTransactionAllocations(client, {
  transactionId,
  allocations,
  memberId = null,
  categorizationSource = 'manual',
  preservePaycheck = false
}) {
  const normalized = normalizeAllocationInput(allocations);
  const { rows: [transaction] } = await client.query(
    `SELECT id, amount, pending, is_transfer, merchant_name, name, merchant_fingerprint
     FROM transactions WHERE id = $1 FOR UPDATE`,
    [transactionId]
  );
  if (!transaction) throw Object.assign(new Error('Transaction not found'), { status: 404 });

  const transactionCents = moneyToCents(transaction.amount);
  const allocationCents = normalized.reduce((sum, allocation) => sum + allocation.cents, 0n);
  if (allocationCents !== transactionCents) {
    throw Object.assign(new Error(
      `Allocation total ${centsToMoney(allocationCents)} must equal transaction amount ${centsToMoney(transactionCents)}`
    ), { status: 400 });
  }

  if (normalized.length > 1 && transaction.pending) {
    throw Object.assign(new Error('Pending transactions cannot be split until they post successfully'), { status: 400 });
  }
  if (normalized.length > 1 && transaction.is_transfer) {
    throw Object.assign(new Error('Transfer transactions cannot be split'), { status: 400 });
  }

  const requestedCategoryIds = normalized.map(row => row.categoryId).filter(id => id !== null);
  if (requestedCategoryIds.length) {
    const { rows: validCategories } = await client.query(
      'SELECT id, is_transfer_class FROM categories WHERE id = ANY($1::int[])',
      [requestedCategoryIds]
    );
    if (validCategories.length !== requestedCategoryIds.length) {
      throw Object.assign(new Error('One or more categories do not exist'), { status: 400 });
    }
    if (normalized.length > 1) {
      const hasTransferClass = validCategories.some(category => category.is_transfer_class);
      if (hasTransferClass) {
        throw Object.assign(new Error('Transfer categories cannot be used in a split'), { status: 400 });
      }
    }
  }

  // category_id is only a compatibility projection during the deployment
  // transition. Updating it first lets the compatibility trigger run; the
  // canonical rows are then replaced below in the same transaction.
  const legacyCategoryId = normalized.length === 1 ? normalized[0].categoryId : null;
  await client.query(
    `UPDATE transactions
     SET category_id = $1,
         categorization_source = $2,
         suggested_category_id = NULL,
         suggestion_source = NULL,
         updated_at = now()
     WHERE id = $3`,
    [legacyCategoryId, categorizationSource, transactionId]
  );

  // A normal category/split replacement explicitly exits paycheck modeling.
  // Reconciliation edits allocation rows in place and therefore preserve the
  // paystub facts while their source-revision status is tracked separately.
  if (!preservePaycheck) {
    const { rows: [paycheck] } = await client.query(
      `SELECT pd.paycheck_event_id, count(*) OVER ()::int AS deposit_count
       FROM paycheck_deposits pd
       WHERE pd.paycheck_event_id = (
         SELECT paycheck_event_id FROM paycheck_deposits WHERE transaction_id = $1
       ) LIMIT 1`, [transactionId]
    );
    if (paycheck?.deposit_count > 1) {
      throw Object.assign(new Error('Edit multi-account paycheck allocations through Paycheck Setup'), { status: 409 });
    }
    if (paycheck) await client.query('DELETE FROM paycheck_events WHERE id = $1', [paycheck.paycheck_event_id]);
  }
  await client.query('DELETE FROM transaction_allocations WHERE transaction_id = $1', [transactionId]);
  for (const allocation of normalized) {
    await client.query(
      `INSERT INTO transaction_allocations
         (transaction_id, category_id, amount, position, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [transactionId, allocation.categoryId, centsToMoney(allocation.cents), allocation.position, memberId]
    );
  }

  return { transaction, allocations: await getTransactionAllocations(client, transactionId) };
}

async function setSingleTransactionCategory(client, {
  transactionId,
  categoryId,
  memberId = null,
  categorizationSource = 'manual'
}) {
  const { rows: [transaction] } = await client.query(
    'SELECT amount FROM transactions WHERE id = $1',
    [transactionId]
  );
  if (!transaction) throw Object.assign(new Error('Transaction not found'), { status: 404 });
  return replaceTransactionAllocations(client, {
    transactionId,
    allocations: [{ category_id: categoryId ?? null, amount: transaction.amount }],
    memberId,
    categorizationSource
  });
}

async function reconcileAllocationsToTransactionAmount(client, transactionId) {
  const { rows: [transaction] } = await client.query(
    'SELECT id, amount FROM transactions WHERE id = $1 FOR UPDATE',
    [transactionId]
  );
  if (!transaction) return null;
  const target = moneyToCents(transaction.amount);
  const allocations = await getTransactionAllocations(client, transactionId);
  if (allocations.length === 0) {
    await client.query(
      `INSERT INTO transaction_allocations (transaction_id, category_id, amount, position)
       VALUES ($1, NULL, $2, 1)`,
      [transactionId, centsToMoney(target)]
    );
    return getTransactionAllocations(client, transactionId);
  }

  const current = allocations.map(row => moneyToCents(row.amount));
  if (current.reduce((sum, value) => sum + value, 0n) === target) return allocations;

  if (allocations.length === 1) {
    await client.query(
      'UPDATE transaction_allocations SET amount = $1, updated_at = now() WHERE id = $2',
      [centsToMoney(target), allocations[0].id]
    );
    return getTransactionAllocations(client, transactionId);
  }

  const nonZeroSigns = new Set(current.filter(value => value !== 0n).map(value => value < 0n ? -1 : 1));
  const isCompound = nonZeroSigns.size > 1;
  if (isCompound) {
    // Preserve user-entered gross income, tax, and benefit facts. Source amount
    // revisions become an explicit uncategorized adjustment instead of silently
    // rewriting whichever categorized line happens to be last.
    const adjustment = allocations.find(allocation => allocation.category_id === null);
    const categorizedTotal = allocations.reduce((sum, allocation, index) => (
      allocation.category_id === null ? sum : sum + current[index]
    ), 0n);
    const adjustmentAmount = target - categorizedTotal;

    if (adjustment) {
      if (adjustmentAmount === 0n) {
        await client.query('DELETE FROM transaction_allocations WHERE id = $1', [adjustment.id]);
      } else {
        await client.query(
          'UPDATE transaction_allocations SET amount = $1, updated_at = now() WHERE id = $2',
          [centsToMoney(adjustmentAmount), adjustment.id]
        );
      }
    } else if (adjustmentAmount !== 0n) {
      const nextPosition = allocations.reduce((max, allocation) => Math.max(max, allocation.position), 0) + 1;
      await client.query(
        `INSERT INTO transaction_allocations (transaction_id, category_id, amount, position)
         VALUES ($1, NULL, $2, $3)`,
        [transactionId, centsToMoney(adjustmentAmount), nextPosition]
      );
    }
    return getTransactionAllocations(client, transactionId);
  } else {
    const targetAbs = target < 0n ? -target : target;
    const weights = current.map(value => value < 0n ? -value : value);
    const totalWeight = weights.reduce((sum, value) => sum + value, 0n);
    if (target === 0n && totalWeight > 0n) {
      const currentTotal = current.reduce((sum, value) => sum + value, 0n);
      const nextPosition = allocations.reduce((max, allocation) => Math.max(max, allocation.position), 0) + 1;
      await client.query(
        `INSERT INTO transaction_allocations (transaction_id, category_id, amount, position)
         VALUES ($1, NULL, $2, $3)`,
        [transactionId, centsToMoney(-currentTotal), nextPosition]
      );
      return getTransactionAllocations(client, transactionId);
    }
    let assigned = 0n;
    for (let index = 0; index < weights.length; index++) {
      const absolute = index === weights.length - 1
        ? targetAbs - assigned
        : totalWeight === 0n
          ? targetAbs / BigInt(weights.length)
          : (targetAbs * weights[index]) / totalWeight;
      assigned += absolute;
      current[index] = target < 0n ? -absolute : absolute;
    }
  }

  for (let index = 0; index < allocations.length; index++) {
    if (current[index] === 0n && allocations.length > 1) {
      await client.query('DELETE FROM transaction_allocations WHERE id = $1', [allocations[index].id]);
    } else {
      await client.query(
        'UPDATE transaction_allocations SET amount = $1, updated_at = now() WHERE id = $2',
        [centsToMoney(current[index]), allocations[index].id]
      );
    }
  }
  const reconciled = await getTransactionAllocations(client, transactionId);
  if (reconciled.length === 1) {
    await client.query(
      'UPDATE transactions SET category_id = $1, updated_at = now() WHERE id = $2',
      [reconciled[0].category_id, transactionId]
    );
  }
  return getTransactionAllocations(client, transactionId);
}

module.exports = {
  MAX_ALLOCATIONS_PER_TRANSACTION,
  moneyToCents,
  centsToMoney,
  normalizeAllocationInput,
  getTransactionAllocations,
  replaceTransactionAllocations,
  setSingleTransactionCategory,
  reconcileAllocationsToTransactionAmount
};
