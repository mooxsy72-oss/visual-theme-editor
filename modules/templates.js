// modules/templates.js
// Шаблоны: именованные группы селекторов.
//
// Идея простая и надёжная: шаблон хранит список селекторов, а при правке
// они склеиваются в один селектор через запятую — «#a, .b, .c». Дальше
// работает обычный механизм записи CSS, поэтому любая вкладка редактора
// (цвет, размер, картинка, шрифт) применяется ко всей группе сразу.
//
// Набор можно прервать и продолжить позже: режим сбора включается для
// конкретного шаблона и просто дописывает в него новые селекторы.

let store = null;              // объект настроек расширения
let persist = null;            // сохранить настройки
let onRequestPick = null;      // включить прицел
let onStopPick = null;         // выключить прицел
let onEditTemplate = null;     // навести панель свойств на шаблон
let onSelectorFor = null;      // построить селектор для элемента
let onToast = null;

let panel = null;
let els = {};

let collectingId = null;       // id шаблона, который сейчас набираем

/* ============================================================
   МИНИ-ХЕЛПЕР DOM
============================================================ */
function h(tagSpec, attrs, children) {
    const idMatch = tagSpec.match(/#([\w-]+)/);
    const clsList = (tagSpec.match(/\.[\w-]+/g) || []).map(s => s.slice(1));
    const tag = (tagSpec.match(/^[\w-]+/) || ['div'])[0];

    const node = document.createElement(tag);
    if (idMatch) node.id = idMatch[1];
    if (clsList.length) node.className = clsList.join(' ');

    if (attrs) {
        for (const [k, v] of Object.entries(attrs)) {
            if (v == null || v === false) continue;
            if (k === 'text') { node.textContent = v; continue; }
            if (k === 'style') { node.style.cssText = v; continue; }
            if (k === 'dataset') { Object.assign(node.dataset, v); continue; }
            if (k === 'on') {
                for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
                continue;
            }
            if (k in node && typeof node[k] !== 'object' && k !== 'list') {
                try { node[k] = v; continue; } catch {}
            }
            node.setAttribute(k, v === true ? '' : v);
        }
    }
    for (const c of [].concat(children || [])) {
        if (c == null || c === false) continue;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
}

function icon(name) {
    return h('i', { className: `fa-solid ${name}` });
}

function iconBtn(faName, title, onClick, extraClass) {
    return h(`button.vte-icon-btn${extraClass ? '.' + extraClass : ''}`, {
        type: 'button', title, on: { click: onClick },
    }, [icon(faName)]);
}

function say(text) {
    onToast?.(text);
}

/* ============================================================
   ИНИЦИАЛИЗАЦИЯ И ХРАНИЛИЩЕ
============================================================ */
export function init(options = {}) {
    store = options.store || {};
    persist = options.persist || (() => {});
    onRequestPick = options.onRequestPick || (() => {});
    onStopPick = options.onStopPick || (() => {});
    onEditTemplate = options.onEditTemplate || (() => {});
    onSelectorFor = options.onSelectorFor || (() => '');
    onToast = options.onToast || (() => {});

    if (!Array.isArray(store.templates)) store.templates = [];
    if (typeof store.activeTemplate !== 'string') store.activeTemplate = '';

    // Чистим мусор, если настройки правились руками
    store.templates = store.templates
        .filter(t => t && typeof t === 'object' && t.id)
        .map(t => ({
            id: String(t.id),
            name: String(t.name || 'Без названия'),
            items: Array.isArray(t.items)
                ? t.items.filter(i => i && i.selector).map(i => ({
                    selector: String(i.selector),
                    label: String(i.label || i.selector),
                }))
                : [],
        }));
}

function list() {
    return store.templates;
}

function byId(id) {
    return list().find(t => t.id === id) || null;
}

function save() {
    persist();
}

function newId() {
    return 'tpl-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/* ============================================================
   ПУБЛИЧНОЕ API
============================================================ */
export function getActive() {
    return byId(store.activeTemplate);
}

/** Склеенный селектор шаблона: '#a, .b, .c'. Пусто, если шаблон не выбран */
export function activeSelector() {
    const t = getActive();
    if (!t || !t.items.length) return '';
    return t.items.map(i => i.selector).join(', ');
}

export function setActive(id) {
    const t = byId(id);
    store.activeTemplate = t ? t.id : '';
    save();
    render();
    return t;
}

export function clearActive() {
    store.activeTemplate = '';
    save();
    render();
}

export function isCollecting() {
    return !!collectingId;
}

/** Шаблон, который сейчас набирается */
export function collectingTemplate() {
    return byId(collectingId);
}

/**
 * Прицел выбрал элемент. Возвращает true, если элемент ушёл в шаблон —
 * тогда index.js не открывает обычную панель свойств.
 */
export function handlePicked(element) {
    if (!collectingId) return false;

    const t = byId(collectingId);
    if (!t) { stopCollect(); return false; }

    const selector = onSelectorFor(element);
    if (!selector) {
        say('Для этого элемента не удалось построить селектор');
        return true;
    }

    if (t.items.some(i => i.selector === selector)) {
        say('Такой селектор уже в шаблоне');
        return true;
    }

    t.items.push({ selector, label: describe(element, selector) });
    save();
    render();
    say(`Добавлено в «${t.name}»: ${t.items.length}`);
    return true;
}

/* ============================================================
   РЕЖИМ НАБОРА
============================================================ */
export function startCollect(id) {
    const t = byId(id);
    if (!t) return;
    collectingId = t.id;
    showPanel();
    render();
    onRequestPick();
    say(`Набор в «${t.name}». Кликайте по элементам, потом нажмите «Готово».`);
}

export function stopCollect() {
    if (!collectingId) return;
    const t = byId(collectingId);
    collectingId = null;
    onStopPick();
    render();
    if (t) {
        say(t.items.length
            ? `Шаблон «${t.name}»: ${t.items.length} ${plural(t.items.length, 'элемент', 'элемента', 'элементов')}`
            : `Шаблон «${t.name}» пока пуст`);
    }
}

/* ============================================================
   ОПЕРАЦИИ С ШАБЛОНАМИ
============================================================ */
function createTemplate() {
    const name = (els.newName.value || '').trim() || `Шаблон ${list().length + 1}`;
    const t = { id: newId(), name, items: [] };
    list().push(t);
    store.activeTemplate = t.id;
    save();
    els.newName.value = '';
    startCollect(t.id);
}

function renameTemplate(t) {
    const next = window.prompt('Название шаблона', t.name);
    if (next == null) return;
    t.name = next.trim() || t.name;
    save();
    render();
}

function deleteTemplate(t) {
    if (!window.confirm(`Удалить шаблон «${t.name}»? Сам CSS при этом не меняется.`)) return;
    store.templates = list().filter(x => x.id !== t.id);
    if (store.activeTemplate === t.id) store.activeTemplate = '';
    if (collectingId === t.id) { collectingId = null; onStopPick(); }
    save();
    render();
    say('Шаблон удалён');
}

function duplicateTemplate(t) {
    const copy = {
        id: newId(),
        name: `${t.name} — копия`,
        items: t.items.map(i => ({ ...i })),
    };
    list().push(copy);
    save();
    render();
}

function removeItem(t, index) {
    t.items.splice(index, 1);
    save();
    render();
}

function editTemplate(t) {
    if (!t.items.length) {
        say('Сначала наберите элементы в шаблон');
        return;
    }
    store.activeTemplate = t.id;
    save();
    render();
    onEditTemplate(t.items.map(i => i.selector).join(', '), t);
}

/* ============================================================
   ПАНЕЛЬ
============================================================ */
export function createPanel() {
    if (panel) {
        panel.style.display = 'flex';
        render();
        return panel;
    }

    els.header = h('div#vte-tpl-header.vte-header', {}, [
        h('div.vte-title', {}, [
            h('span.vte-title-ic', {}, [icon('fa-layer-group')]),
            h('span', { text: 'Шаблоны групп' }),
        ]),
        h('div.vte-header-btns', {}, [
            iconBtn('fa-window-minimize', 'Свернуть',
                () => panel.classList.toggle('vte-collapsed')),
            iconBtn('fa-xmark', 'Закрыть', hidePanel, 'vte-icon-btn-close'),
        ]),
    ]);

    els.newName = h('input.vte-input', {
        type: 'text', spellcheck: false,
        placeholder: 'Название нового шаблона',
        on: {
            keydown: (e) => { if (e.key === 'Enter') createTemplate(); },
        },
    });

    els.createRow = h('div.vte-tpl-create', {}, [
        els.newName,
        h('button.vte-btn.vte-btn-primary', {
            type: 'button',
            title: 'Создать шаблон и сразу начать набор элементов',
            on: { click: createTemplate },
        }, [icon('fa-plus'), h('span', { text: ' Создать' })]),
    ]);

    els.collectBar = h('div#vte-tpl-collect.vte-tpl-collect', { style: 'display:none' });
    els.list = h('div#vte-tpl-list.vte-tpl-list');

    els.note = h('small.vte-note', {
        text: 'Правки применяются ко всем элементам шаблона сразу: '
            + 'в CSS пишется одно правило со списком селекторов через запятую.',
    });

    panel = h('div#vte-templates-panel.vte-panel.vte-tpl-panel', {}, [
        els.header,
        h('div.vte-tpl-body', {}, [els.createRow, els.collectBar, els.list, els.note]),
    ]);

    document.body.appendChild(panel);
    makeDraggable(panel, els.header);
    shield(panel);
    render();
    return panel;
}

export function showPanel() {
    if (!panel) createPanel();
    panel.style.display = 'flex';
    render();
}

export function hidePanel() {
    if (panel) panel.style.display = 'none';
}

export function isOpen() {
    return !!panel && panel.style.display !== 'none';
}

export function togglePanel() {
    isOpen() ? hidePanel() : showPanel();
}

/* ============================================================
   ОТРИСОВКА
============================================================ */
function render() {
    if (!panel) return;
    renderCollectBar();
    renderList();
}

function renderCollectBar() {
    const bar = els.collectBar;
    const t = byId(collectingId);

    if (!t) { bar.style.display = 'none'; bar.textContent = ''; return; }

    bar.textContent = '';
    bar.style.display = 'flex';
    bar.append(
        h('span.vte-tpl-collect-ic', {}, [icon('fa-crosshairs')]),
        h('span.vte-tpl-collect-text', {
            text: `Набор в «${t.name}» — выбрано ${t.items.length}. `
                + 'Кликайте по элементам интерфейса.',
        }),
        h('button.vte-btn.vte-btn-primary', {
            type: 'button',
            on: { click: stopCollect },
        }, [icon('fa-check'), h('span', { text: ' Готово' })]),
    );
}

function renderList() {
    const box = els.list;
    box.textContent = '';

    if (!list().length) {
        box.appendChild(h('div.vte-tpl-empty', {}, [
            h('span.vte-empty-ic', {}, [icon('fa-layer-group')]),
            h('div', { text: 'Шаблонов пока нет' }),
            h('small', {
                text: 'Введите название, нажмите «Создать» и прицелом соберите '
                    + 'однотипные элементы — например все заголовки панелей',
            }),
        ]));
        return;
    }

    for (const t of list()) {
        box.appendChild(templateCard(t));
    }
}

function templateCard(t) {
    const isActive = store.activeTemplate === t.id;
    const isCollect = collectingId === t.id;

    const head = h('div.vte-tpl-head', {}, [
        h('button.vte-tpl-name', {
            type: 'button',
            title: 'Сделать этот шаблон текущим',
            on: { click: () => setActive(t.id) },
        }, [
            icon(isActive ? 'fa-circle-dot' : 'fa-circle'),
            h('span', { text: ' ' + t.name }),
        ]),
        h('span.vte-tpl-count', {
            text: `${t.items.length}`,
            title: `${t.items.length} ${plural(t.items.length, 'селектор', 'селектора', 'селекторов')}`,
        }),
        h('div.vte-tpl-btns', {}, [
            iconBtn('fa-pen', 'Переименовать', () => renameTemplate(t)),
            iconBtn('fa-copy', 'Дублировать', () => duplicateTemplate(t)),
            iconBtn('fa-trash', 'Удалить', () => deleteTemplate(t), 'vte-icon-btn-close'),
        ]),
    ]);

    const items = h('div.vte-tpl-items');
    if (!t.items.length) {
        items.appendChild(h('div.vte-tpl-item-empty', {
            text: 'Пусто — нажмите «Добавить элементы»',
        }));
    } else {
        t.items.forEach((item, i) => {
            items.appendChild(h('div.vte-tpl-item', {}, [
                h('span.vte-tpl-item-n', { text: String(i + 1) }),
                h('code.vte-tpl-item-sel', {
                    text: item.label,
                    title: item.selector,
                }),
                h('span.vte-tpl-item-hits', {
                    text: hitsLabel(item.selector),
                    title: 'Сколько элементов на странице попадают в этот селектор',
                }),
                iconBtn('fa-xmark', 'Убрать из шаблона', () => removeItem(t, i)),
            ]));
        });
    }

    const actions = h('div.vte-tpl-actions', {}, [
        isCollect
            ? h('button.vte-btn', {
                type: 'button',
                on: { click: stopCollect },
            }, [icon('fa-check'), h('span', { text: ' Закончить набор' })])
            : h('button.vte-btn', {
                type: 'button',
                title: 'Включить прицел и дописать элементы в этот шаблон',
                on: { click: () => startCollect(t.id) },
            }, [icon('fa-crosshairs'), h('span', { text: ' Добавить элементы' })]),

        h('button.vte-btn.vte-btn-primary', {
            type: 'button',
            title: 'Открыть панель свойств и править всю группу сразу',
            disabled: !t.items.length,
            on: { click: () => editTemplate(t) },
        }, [icon('fa-sliders'), h('span', { text: ' Править группу' })]),
    ]);

    const card = h('div.vte-tpl-card', {}, [head, items, actions]);
    if (isActive) card.classList.add('vte-tpl-active');
    if (isCollect) card.classList.add('vte-tpl-collecting');
    return card;
}

/* ============================================================
   МЕЛОЧИ
============================================================ */
function describe(element, selector) {
    let out = element.tagName.toLowerCase();
    if (element.id) out += '#' + element.id;
    else {
        const cls = Array.from(element.classList)
            .filter(c => !c.startsWith('vte-'))
            .slice(0, 2);
        if (cls.length) out += '.' + cls.join('.');
    }
    return out.length > 2 ? out : selector;
}

function hitsLabel(selector) {
    try {
        const n = document.querySelectorAll(selector).length;
        return n === 1 ? '1' : `×${n}`;
    } catch {
        return '?';
    }
}

function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
}

function makeDraggable(box, handle) {
    let sx = 0, sy = 0, ox = 0, oy = 0, active = false;

    handle.addEventListener('pointerdown', (e) => {
        if (e.target.closest('.vte-icon-btn')) return;
        active = true;
        const r = box.getBoundingClientRect();
        sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
        box.style.right = 'auto';
        box.style.left = `${ox}px`;
        box.style.top = `${oy}px`;
        handle.setPointerCapture(e.pointerId);
        box.classList.add('vte-dragging');
    });

    handle.addEventListener('pointermove', (e) => {
        if (!active) return;
        box.style.left = `${Math.max(0, Math.min(window.innerWidth - 80, ox + e.clientX - sx))}px`;
        box.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, oy + e.clientY - sy))}px`;
    });

    const stop = () => { active = false; box.classList.remove('vte-dragging'); };
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
}

function shield(node) {
    ['pointerdown', 'mousedown', 'touchstart', 'click'].forEach(t =>
        node.addEventListener(t, (e) => e.stopPropagation()));
}
