/* eslint-disable no-unused-vars */
'use strict';

// ── State ────────────────────────────────────────────────────

let categories = [];
let rules = [];
let selectedColor = '#6b7280';

const COLOR_PALETTE = [
  '#22c55e', '#f97316', '#64748b', '#06b6d4', '#ef4444', '#a855f7',
  '#ec4899', '#f59e0b', '#6366f1', '#84cc16', '#0ea5e9', '#78716c'
];

// ── Boot ─────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await Promise.all([loadCategories(), loadRules()]);
});

// ── Categories ───────────────────────────────────────────────

async function loadCategories() {
  try {
    categories = await api('api/categories');
    renderCategories();
  } catch (err) {
    console.error('Failed to load categories:', err);
  }
}

function renderCategories() {
  const list = $('category-admin-list');
  if (categories.length === 0) {
    list.innerHTML = '<div class="empty-state">No categories</div>';
    return;
  }

  list.innerHTML = categories.map(c => `
    <div class="admin-row">
      <div class="admin-row-info">
        <span class="cat-swatch" style="background:${c.color}"></span>
        <div class="admin-row-copy">
          <span class="name">${c.icon || ''} ${esc(c.name)}</span>
          <span class="meta">${c.transaction_count} txns${c.budget_amount ? ' · $' + parseFloat(c.budget_amount).toFixed(0) + '/mo' : ''}${c.is_income ? ' · income' : ''}${c.is_transfer_class ? ' · transfer' : ''}${c.exclude_from_baseline ? ' · baseline excluded' : ''}</span>
        </div>
      </div>
      <div class="admin-row-actions">
        ${!c.is_income && !c.is_transfer_class ? `
          <label class="checkbox-row admin-inline-toggle" title="Exclude this category from forecast baseline">
            <input
              type="checkbox"
              ${c.exclude_from_baseline ? 'checked' : ''}
              onchange="toggleBaselineExclusion(${c.id}, this.checked)"
            >
            Baseline
          </label>
        ` : ''}
        <button class="btn-ghost" onclick="openCategoryForm(${c.id})">Edit</button>
        <button class="btn-danger" onclick="deleteCategory(${c.id})">Delete</button>
      </div>
    </div>
  `).join('');
}

function openCategoryForm(id) {
  const cat = id ? categories.find(c => c.id === id) : null;
  $('cat-form-title').textContent = cat ? 'Edit Category' : 'New Category';
  $('cat-form-id').value = cat ? cat.id : '';
  $('cat-name').value = cat ? cat.name : '';
  $('cat-budget').value = cat?.budget_amount || '';
  $('cat-icon').value = cat?.icon || '';
  $('cat-income').checked = cat?.is_income || false;
  $('cat-exclude-from-baseline').checked = cat?.exclude_from_baseline || false;
  selectedColor = cat?.color || '#6b7280';

  // Render color palette
  $('cat-color-palette').innerHTML = COLOR_PALETTE.map(c =>
    `<button class="color-swatch ${c === selectedColor ? 'selected' : ''}" style="background:${c}" onclick="pickColor('${c}')"></button>`
  ).join('');

  $('category-form-overlay').classList.remove('hidden');
}

function pickColor(color) {
  selectedColor = color;
  document.querySelectorAll('.color-swatch').forEach(s => {
    s.classList.toggle('selected', s.style.backgroundColor === colorToRgb(color));
  });
}

function closeCategoryForm() {
  $('category-form-overlay').classList.add('hidden');
}

async function saveCategory() {
  const id = $('cat-form-id').value;
  const body = {
    name: $('cat-name').value.trim(),
    color: selectedColor,
    budget_amount: $('cat-budget').value ? parseFloat($('cat-budget').value) : null,
    icon: $('cat-icon').value.trim() || null,
    is_income: $('cat-income').checked,
    is_transfer_class: false,
    exclude_from_baseline: $('cat-exclude-from-baseline').checked
  };

  if (!body.name) return alert('Name is required');

  try {
    if (id) {
      await api(`api/categories/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    } else {
      await api('api/categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    }
    closeCategoryForm();
    await loadCategories();
    populateRuleCategorySelect();
  } catch (err) {
    alert(err.message);
  }
}

async function deleteCategory(id) {
  if (!confirm('Delete this category?')) return;
  try {
    await api(`api/categories/${id}`, { method: 'DELETE' });
    await loadCategories();
  } catch (err) {
    alert(err.message);
  }
}

async function toggleBaselineExclusion(id, checked) {
  const cat = categories.find(c => c.id === id);
  if (!cat) return;

  try {
    await api(`api/categories/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ exclude_from_baseline: checked })
    });
    await loadCategories();
  } catch (err) {
    alert(err.message);
    await loadCategories();
  }
}

// ── Rules ────────────────────────────────────────────────────

async function loadRules() {
  try {
    rules = await api('api/rules');
    renderRules();
  } catch (err) {
    console.error('Failed to load rules:', err);
  }
}

function renderRules() {
  const list = $('rules-admin-list');
  if (rules.length === 0) {
    list.innerHTML = '<div class="empty-state">No rules — create one to auto-categorize transactions</div>';
    return;
  }

  list.innerHTML = rules.map(r => `
    <div class="admin-row">
      <div class="admin-row-info">
        <span class="cat-swatch" style="background:${r.category_color}"></span>
        <span class="name">"${esc(r.merchant_pattern)}"</span>
        <span class="meta">${r.match_type} → ${r.category_icon || ''} ${esc(r.category_name)}</span>
      </div>
      <div class="admin-row-actions">
        <button class="btn-ghost" onclick="openRuleForm(${r.id})">Edit</button>
        <button class="btn-danger" onclick="deleteRule(${r.id})">Delete</button>
      </div>
    </div>
  `).join('');
}

function openRuleForm(id) {
  const rule = id ? rules.find(r => r.id === id) : null;
  $('rule-form-title').textContent = rule ? 'Edit Rule' : 'New Rule';
  $('rule-form-id').value = rule ? rule.id : '';
  $('rule-pattern').value = rule ? rule.merchant_pattern : '';
  $('rule-match-type').value = rule ? rule.match_type : 'contains';
  $('preview-container').classList.add('hidden');

  populateRuleCategorySelect();
  if (rule) $('rule-category').value = rule.category_id;

  $('rule-form-overlay').classList.remove('hidden');
}

function populateRuleCategorySelect() {
  const sel = $('rule-category');
  sel.innerHTML = categories
    .filter(c => !c.is_transfer_class)
    .map(c => `<option value="${c.id}">${c.icon || ''} ${esc(c.name)}</option>`)
    .join('');
}

function closeRuleForm() {
  $('rule-form-overlay').classList.add('hidden');
}

async function saveRule() {
  const id = $('rule-form-id').value;
  const body = {
    merchant_pattern: $('rule-pattern').value.trim(),
    category_id: parseInt($('rule-category').value),
    match_type: $('rule-match-type').value
  };

  if (!body.merchant_pattern) return alert('Pattern is required');

  try {
    if (id) {
      await api(`api/rules/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    } else {
      await api('api/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    }
    closeRuleForm();
    await loadRules();
  } catch (err) {
    alert(err.message);
  }
}

async function deleteRule(id) {
  if (!confirm('Delete this rule?')) return;
  try {
    await api(`api/rules/${id}`, { method: 'DELETE' });
    await loadRules();
  } catch (err) {
    alert(err.message);
  }
}

async function previewCurrentRule() {
  const pattern = $('rule-pattern').value.trim();
  if (!pattern) return alert('Enter a pattern first');

  try {
    const data = await api('api/rules/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern, match_type: $('rule-match-type').value })
    });

    $('preview-count').textContent = `${data.count} matching transaction(s)`;
    $('preview-list').innerHTML = data.matches.slice(0, 20).map(m =>
      `<div class="preview-item">${esc(m.merchant_name || m.name)} · ${fmtMoney(m.amount)} · ${m.date}</div>`
    ).join('') || '<div class="preview-item" style="color:var(--dim)">No matches</div>';
    $('preview-container').classList.remove('hidden');
  } catch (err) {
    alert(err.message);
  }
}

async function applyRulesRetroactive() {
  if (!confirm('Apply all rules to uncategorized transactions?')) return;
  try {
    const result = await api('api/rules/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    alert(`Categorized ${result.matched} of ${result.total} uncategorized transactions.`);
  } catch (err) {
    alert(err.message);
  }
}

// ── Helpers ──────────────────────────────────────────────────

function $(id) { return document.getElementById(id); }

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtMoney(amount) {
  const n = parseFloat(amount) || 0;
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `-$${abs}` : `$${abs}`;
}

function colorToRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgb(${r}, ${g}, ${b})`;
}

async function api(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}
