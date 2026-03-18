'use strict';

const ACCOUNT_SELECTION_MODE = Object.freeze({
  EDITABLE: 'editable',
  UNAVAILABLE: 'unavailable'
});

function isChaseItem(item) {
  const institutionId = String(item?.institution_id || '');
  const institutionName = String(item?.institution_name || '');
  // `ins_56` is Plaid's institution id for Chase.
  return institutionId === 'ins_56' || /chase/i.test(institutionName);
}

function deriveAccountSelectionState(item) {
  if (!item || item.status === 'disconnected' || item.status === 'needs_reauth') {
    return {
      mode: ACCOUNT_SELECTION_MODE.UNAVAILABLE,
      label: null,
      help: null,
      removal_requires_bank: false
    };
  }

  if (isChaseItem(item)) {
    return {
      mode: ACCOUNT_SELECTION_MODE.EDITABLE,
      label: 'Edit synced accounts',
      help: 'Chase account removals must be managed in Chase Security Center. Use Edit synced accounts after updating Chase permissions to add newly shared accounts or refresh the sync group.',
      removal_requires_bank: true
    };
  }

  return {
    mode: ACCOUNT_SELECTION_MODE.EDITABLE,
    label: 'Edit synced accounts',
    help: 'Review which accounts under this institution should keep syncing. Deselected accounts stay in Family Pulse history as historical accounts.',
    removal_requires_bank: false
  };
}

module.exports = {
  ACCOUNT_SELECTION_MODE,
  deriveAccountSelectionState
};
