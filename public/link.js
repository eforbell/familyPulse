'use strict';

let linkState = null;

document.addEventListener('DOMContentLoaded', loadLinks);

function setLinkStatus(message, isError = false) {
  const el = document.getElementById('link-status');
  el.textContent = message;
  el.classList.toggle('link-error', isError);
}

async function loadLinks() {
  try {
    const res = await fetch('api/suite/links', { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load household members');
    linkState = data;
    renderLinks();
  } catch (err) {
    setLinkStatus(err.message, true);
  }
}

function note(text) {
  const p = document.createElement('p');
  p.className = 'link-note';
  p.textContent = text;
  return p;
}

function renderLinks() {
  const { you, directory, members } = linkState;
  const rows = document.getElementById('link-rows');
  rows.replaceChildren();
  const linked = new Map(members.filter((m) => m.suite_member_id).map((m) => [m.suite_member_id, m.id]));

  for (const member of members) {
    const row = document.createElement('div');
    row.className = 'link-row';

    const who = document.createElement('span');
    who.className = 'link-who';
    const avatar = document.createElement('span');
    avatar.textContent = member.avatar_emoji || '👤';
    const name = document.createElement('span');
    name.className = 'link-name';
    name.textContent = member.name;
    const role = document.createElement('span');
    role.className = 'link-role';
    role.textContent = member.role === 'parent' ? 'parent' : 'kid';
    who.append(avatar, name, role);

    const select = document.createElement('select');
    select.className = 'login-input';
    select.setAttribute('aria-label', `Household account for ${member.name}`);
    select.append(new Option('Not linked', ''));
    for (const person of directory) {
      const takenBy = linked.get(person.memberId);
      if (takenBy && takenBy !== member.id) continue;
      if (member.role === 'parent' && person.role !== 'parent') continue;
      const label = `${person.name} (${person.role}${person.memberId === you ? ', you' : ''})`;
      select.append(new Option(label, person.memberId, false, person.memberId === member.suite_member_id));
    }
    select.addEventListener('change', () => saveLink(member, select));
    row.append(who, select);

    const account = directory.find((person) => person.memberId === member.suite_member_id);
    if (member.suite_member_id && !account) {
      row.append(note('Linked to a household account that no longer has access to Family Pulse.'));
    } else if (account && account.role !== member.role) {
      row.append(note(`Home Base lists ${account.name} as a ${account.role}, so that's what they are here.`));
    }
    rows.append(row);
  }

  const youLinked = linked.has(you);
  const done = document.getElementById('link-done');
  done.classList.toggle('hidden', !youLinked && members.length > 0);
  if (!members.length) {
    done.textContent = 'Set up the household';
    done.href = 'setup';
    setLinkStatus('Family Pulse has no members yet. Set up the household first.');
  } else if (!youLinked) {
    setLinkStatus('Start with yourself: pick which Family Pulse member you are.');
  } else {
    setLinkStatus('Changes save as you pick them.');
  }
}

async function saveLink(member, select) {
  select.disabled = true;
  try {
    const res = await fetch(`api/suite/links/${member.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ suite_member_id: select.value || null }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not save');
    await loadLinks();
  } catch (err) {
    setLinkStatus(err.message, true);
    select.disabled = false;
  }
}
