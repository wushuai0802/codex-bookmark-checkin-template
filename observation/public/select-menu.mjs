// A single in-page option list for visible selects. The native select remains
// the value source for existing filters and site controls, but is not focusable.
let active = null;
let sequence = 0;

function closeMenu(restoreFocus = false) {
  if (!active) return;
  const { menu, trigger } = active;
  active = null;
  menu.remove();
  trigger.setAttribute('aria-expanded', 'false');
  if (restoreFocus && trigger.isConnected) trigger.focus({ preventScroll:true });
}

function positionMenu() {
  if (!active) return;
  const { menu, trigger } = active;
  if (!trigger.isConnected) { closeMenu(); return; }
  const box = trigger.getBoundingClientRect();
  const margin = 12;
  const below = window.innerHeight - box.bottom - margin;
  const above = box.top - margin;
  const height = Math.max(80, Math.min(360, Math.max(below, above) - 6));
  const openAbove = below < Math.min(240, above);
  const width = Math.min(window.innerWidth - margin * 2,
    Math.max(box.width, window.innerWidth <= 700 ? 320 : 260));
  menu.style.width = width + 'px';
  menu.style.maxHeight = height + 'px';
  menu.style.left = Math.min(window.innerWidth - width - margin, Math.max(margin, box.left)) + 'px';
  menu.style.top = (openAbove ? Math.max(margin, box.top - height - 6) : box.bottom + 6) + 'px';
}

function openMenu(select, trigger) {
  if (active?.trigger === trigger) { closeMenu(true); return; }
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'ui-select-menu';
  menu.id = 'ui-select-list-' + ++sequence;
  menu.setAttribute('role', 'listbox');
  menu.setAttribute('aria-label', select.getAttribute('aria-label') || '选择项目');
  trigger.setAttribute('aria-controls', menu.id);
  trigger.setAttribute('aria-expanded', 'true');
  const options = [...select.options];
  const rows = options.map((option, index) => {
    const row = document.createElement('div');
    row.className = 'ui-select-option';
    row.id = menu.id + '-option-' + index;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(option.selected));
    if (option.disabled) row.setAttribute('aria-disabled', 'true');
    row.tabIndex = -1;
    row.textContent = option.textContent;
    menu.append(row);
    return row;
  });
  const enabled = index => !options[index]?.disabled;
  const focus = index => {
    const target = rows[index];
    if (!target || !enabled(index)) return;
    for (const row of rows) row.tabIndex = row === target ? 0 : -1;
    target.focus({ preventScroll:true });
    target.scrollIntoView({ block:'nearest' });
  };
  const choose = index => {
    if (!enabled(index)) return;
    select.value = options[index].value;
    select.dispatchEvent(new Event('change', { bubbles:true }));
    closeMenu(true);
  };
  rows.forEach((row,index) => row.addEventListener('click', () => choose(index)));
  let typed = '';
  let typedAt = 0;
  menu.addEventListener('keydown', event => {
    const index = rows.indexOf(document.activeElement);
    if (event.key === 'Escape') { event.preventDefault(); closeMenu(true); return; }
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(index); return; }
    if (event.key === 'Tab') {
      event.preventDefault();
      const previous = event.shiftKey;
      closeMenu();
      const focusables = [...document.querySelectorAll('button:not(:disabled),input:not(:disabled),a[href],summary,[tabindex="0"]')]
        .filter(node => node.getClientRects().length && !node.closest('[inert]'));
      const position = focusables.indexOf(trigger);
      focusables[position + (previous ? -1 : 1)]?.focus();
      return;
    }
    let next = index;
    if (event.key === 'ArrowDown') next = Math.min(rows.length - 1, index + 1);
    else if (event.key === 'ArrowUp') next = Math.max(0, index - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = rows.length - 1;
    else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      typed = performance.now() - typedAt < 650 ? typed + event.key.toLocaleLowerCase() : event.key.toLocaleLowerCase();
      typedAt = performance.now();
      next = options.findIndex(option => !option.disabled && option.textContent.toLocaleLowerCase().startsWith(typed));
      if (next < 0) return;
    } else return;
    event.preventDefault();
    if (!enabled(next)) {
      const step = next < index ? -1 : 1;
      while (next >= 0 && next < rows.length && !enabled(next)) next += step;
    }
    focus(next);
  });
  document.body.append(menu);
  active = { menu, trigger };
  positionMenu();
  focus(Math.max(0, options.findIndex(option => option.selected && !option.disabled)));
}

document.addEventListener('pointerdown', event => {
  if (active && !active.menu.contains(event.target) && !active.trigger.contains(event.target)) closeMenu();
}, true);
document.addEventListener('keydown', event => {
  if (active && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(true); }
}, true);
window.addEventListener('resize', positionMenu);
window.addEventListener('scroll', event => {
  if (active && !active.menu.contains(event.target)) positionMenu();
}, true);

export function enhanceSelect(select) {
  if (!select || select._syncMenu) return select;
  const wrapper = document.createElement('div');
  wrapper.className = 'ui-select';
  if (select.id) wrapper.dataset.for = select.id;
  select.before(wrapper);
  wrapper.append(select);
  select.classList.add('ui-select-native');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden','true');
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'ui-select-trigger';
  trigger.setAttribute('aria-haspopup','listbox');
  trigger.setAttribute('aria-expanded','false');
  const caption = document.createElement('span');
  caption.className = 'ui-select-caption';
  const chevron = document.createElement('span');
  chevron.className = 'ui-select-chevron';
  chevron.setAttribute('aria-hidden','true');
  chevron.textContent = '⌄';
  trigger.append(caption,chevron);
  wrapper.append(trigger);
  const sync = () => {
    wrapper.hidden = select.hidden;
    trigger.disabled = select.disabled || select.options.length === 0;
    caption.textContent = select.selectedOptions[0]?.textContent ?? '请选择';
    trigger.setAttribute('aria-label',
      (select.getAttribute('aria-label') || '选择项目') + '：' + caption.textContent);
  };
  select.addEventListener('change', sync);
  trigger.addEventListener('click', () => openMenu(select, trigger));
  trigger.addEventListener('keydown', event => {
    if (['ArrowDown','ArrowUp','Enter',' '].includes(event.key)) {
      event.preventDefault();
      if (!active || active.trigger !== trigger) openMenu(select,trigger);
    }
  });
  select._syncMenu = sync;
  sync();
  return select;
}

export function closeSelectMenu() { closeMenu(); }
