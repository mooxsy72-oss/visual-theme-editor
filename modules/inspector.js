// modules/inspector.js
// Панель свойств выбранного элемента.
// Ключевая идея: пока пользователь тянет ползунок, наружу летят "живые"
// события (только предпросмотр). Тяжёлая запись в CSS — один раз, по отпусканию.

import * as rules from './cssRules.js';
import * as iconTool from './iconTool.js';

let onPropertyChange = null;
let onRequestVarInfo = null;
let onFontsTabMount = null;
let onPickAgain = null;
let onUndo = null;
let onRedo = null;
let onOpenTemplates = null;
let picker = null;

let panel = null;
let els = {};

let el = null;
let sel = '';              // итоговый селектор, вместе с ::after
let baseSelector = '';     // тот же селектор, но без псевдоэлемента
let pseudo = '';           // '' | '::before' | '::after'
let targetInfo = null;     // варианты целей, собранные в index.js
let cs = null;
let useVars = true;
let userWantsVars = true;   // что выбрал человек, до принудительной блокировки
let fontsMounted = false;
let iconMounted = false;
let onBatchChange = null;
let onTextApply = null;

// Правим не один элемент, а группу по шаблону. Значения читаются
// с элемента-представителя, а запись идёт в общий селектор со списком
// через запятую. Переменные темы в этом режиме запрещены: они меняют
// весь интерфейс, а не только группу.
let groupMode = null;      // null | имя шаблона

const timers = new Map();
const DEBOUNCE = 40;

/* ============================================================
   DOM-ХЕЛПЕРЫ
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

/* ============================================================
   ИНИЦИАЛИЗАЦИЯ
============================================================ */
export function init(options = {}) {
    onPropertyChange = options.onPropertyChange || (() => {});
    onBatchChange = options.onBatchChange || null;
    onRequestVarInfo = options.onRequestVarInfo || (() => null);
    onFontsTabMount = options.onFontsTabMount || (() => {});
    onPickAgain = options.onPickAgain || (() => {});
    onUndo = options.onUndo || (() => {});
    onRedo = options.onRedo || (() => {});
    onOpenTemplates = options.onOpenTemplates || null;
    onTextApply = options.onTextApply || null;
    picker = options.picker || null;

    iconTool.init({
        picker,

        onRequestLayer: (p) => {
            setPseudo(p || '');
            switchTab('icon');
        },

        onApply: (decls, info) => {
            if (!sel) return;

            writeDecls(sel, { ...decls });

            if (info?.hostDecls) {
                const hostSel = baseOf(sel);
                if (hostSel && hostSel !== normalizeSel(sel)) {
                    writeDecls(hostSel, info.hostDecls);
                }
            }

            if (info?.glyphElsewhere) {
                const ghostSel = distributeSuffix(sel, info.glyphElsewhere);
                if (ghostSel) {
                    writeDecls(ghostSel, {
                        'content': '""',
                        'display': 'none',
                        'background-image': 'none',
                        'mask-image': 'none',
                        '-webkit-mask-image': 'none',
                    });
                }
            }

            if (info?.hoverDecls) {
                const hoverSel = withHover(sel);
                if (hoverSel) writeDecls(hoverSel, info.hoverDecls);
            }

            flash(info?.message || 'Применено');
            setTimeout(refresh, 340);
        },
    });
}

export function isVariableMode() {
    return useVars;
}

/**
 * Перечитать значения выбранной цели заново.
 * Нужно после undo/redo: в CSS правка откатилась, а поля панели
 * продолжали показывать старое значение.
 */
export function refreshValues() {
    if (!el || !el.isConnected) return;
    if (!panel || panel.style.display === 'none') return;
    refresh();
}

/* ============================================================
   ПАНЕЛЬ
============================================================ */
export function createPanel() {
    if (panel) {
        panel.style.display = 'flex';
        return panel;
    }

    els.title = h('div.vte-title', {}, [
        h('span.vte-title-ic', {}, [icon('fa-wand-magic-sparkles')]),
        h('span', { text: 'Редактор темы' }),
    ]);

    els.header = h('div#vte-header.vte-header', {}, [
        els.title,
        h('div.vte-header-btns', {}, [
            onOpenTemplates
                ? iconBtn('fa-layer-group', 'Шаблоны групп элементов', () => onOpenTemplates())
                : null,
            iconBtn('fa-crosshairs', 'Выбрать другой элемент', () => onPickAgain()),
            iconBtn('fa-rotate-left', 'Отменить (Ctrl+Z)', () => onUndo()),
            iconBtn('fa-rotate-right', 'Вернуть (Ctrl+Shift+Z)', () => onRedo()),
            iconBtn('fa-window-minimize', 'Свернуть', () => panel.classList.toggle('vte-collapsed')),
            iconBtn('fa-xmark', 'Закрыть', hidePanel, 'vte-icon-btn-close'),
        ]),
    ]);

    els.selectorInput = h('input#vte-selector.vte-selector-input', {
        type: 'text', readOnly: true, spellcheck: false,
        title: 'CSS-селектор, в который пойдёт правка',
    });

    els.selectorRow = h('div.vte-selector-row', {}, [
        h('span.vte-selector-ic', {}, [icon('fa-code')]),
        els.selectorInput,
        iconBtn('fa-copy', 'Скопировать селектор', () => {
            navigator.clipboard?.writeText(els.selectorInput.value);
            flash('Селектор скопирован');
        }),
    ]);

    /* ---- Выбор цели: сам элемент или его псевдоэлемент ---- */
    els.pseudoSeg = h('div#vte-pseudo-seg.vte-seg.vte-pseudo-seg');

    els.selectorPick = h('select#vte-selector-pick.vte-select.vte-selector-pick', {
        title: 'В какое правило писать изменения',
        on: { change: () => applySelectorChoice(els.selectorPick.value) },
    });

    els.targetRow = h('div#vte-target-row.vte-target-row', { style: 'display:none' }, [
        h('div.vte-target-line', {}, [
            h('span.vte-target-label', { text: 'Цель' }),
            els.pseudoSeg,
        ]),
        h('div.vte-target-line#vte-target-rule', {}, [
            h('span.vte-target-label', { text: 'Правило' }),
            els.selectorPick,
        ]),
    ]);

    els.crumbs = h('div#vte-crumbs.vte-crumbs');

    els.varsToggle = h('input', {
        type: 'checkbox', checked: true,
        on: {
            change: (e) => {
                userWantsVars = e.target.checked;
                useVars = e.target.checked;
                if (el) refresh();
            },
        },
    });

    els.varHint = h('div#vte-var-hint.vte-var-hint');

    els.modeRow = h('div.vte-mode-row', {}, [
        h('label.vte-check', {}, [els.varsToggle, h('span', { text: 'Через переменные темы' })]),
        els.varHint,
    ]);

    const tabDefs = [
        ['colors', 'Цвет', 'fa-palette'],
        ['layout', 'Размер', 'fa-ruler-combined'],
        ['icon', 'Картинка', 'fa-image'],
        ['type', 'Текст', 'fa-font'],
        ['fx', 'Эффекты', 'fa-wand-sparkles'],
        ['fonts', 'Шрифты', 'fa-cloud-arrow-down'],
    ];

    els.tabs = h('div.vte-tabs');
    els.panes = {};
    const paneWrap = h('div.vte-panes');

    tabDefs.forEach(([id, label, faName], i) => {
        const tab = h('button.vte-tab', {
            type: 'button',
            dataset: { tab: id },
            title: label,
            on: { click: () => switchTab(id) },
        }, [icon(faName), h('span.vte-tab-label', { text: label })]);
        if (i === 0) tab.classList.add('active');
        els.tabs.appendChild(tab);

        const pane = h('div.vte-pane', { dataset: { pane: id } });
        if (i === 0) pane.classList.add('active');
        els.panes[id] = pane;
        paneWrap.appendChild(pane);
    });

    els.status = h('div#vte-status.vte-status');

    els.footer = h('div.vte-footer', {}, [
        h('button.vte-btn.vte-btn-ghost', {
            type: 'button',
            title: 'Убрать все правила, созданные для этой цели',
            on: { click: () => { commitNow('__reset__', ''); flash('Правила цели убраны'); } },
        }, [icon('fa-eraser'), h('span', { text: ' Сбросить' })]),
        h('button.vte-btn.vte-btn-primary', {
            type: 'button',
            on: { click: hidePanel },
        }, [icon('fa-check'), h('span', { text: ' Готово' })]),
    ]);

    els.empty = h('div#vte-empty.vte-empty', {}, [
        h('span.vte-empty-ic', {}, [icon('fa-hand-pointer')]),
        h('div', { text: 'Элемент не выбран' }),
        h('small', { text: 'Наведите курсор на любую часть интерфейса и кликните' }),
    ]);

    els.content = h('div#vte-content.vte-content', { style: 'display:none' }, [
        els.selectorRow, els.targetRow, els.crumbs, els.modeRow, els.tabs, paneWrap,
    ]);

    panel = h('div#vte-inspector-panel.vte-panel', {}, [
        els.header, els.empty, els.content, els.status, els.footer,
    ]);

    document.body.appendChild(panel);

    makeDraggable(panel, els.header);
    shield(panel);

    return panel;
}


export function hidePanel() {
    if (panel) panel.style.display = 'none';
    picker?.close?.(false);
}

function switchTab(id) {
    els.tabs.querySelectorAll('.vte-tab').forEach(t =>
        t.classList.toggle('active', t.dataset.tab === id));
    for (const [key, pane] of Object.entries(els.panes)) {
        pane.classList.toggle('active', key === id);
    }
    if (id === 'fonts' && !fontsMounted) {
        fontsMounted = true;
        onFontsTabMount(els.panes.fonts);
    }
    if (id === 'icon') {
        if (!iconMounted) {
            iconMounted = true;
            iconTool.mount(els.panes.icon);
        }
        iconTool.update({ selector: sel, pseudo, computed: cs, element: el });
    }
}

/* ============================================================
   ЗАПОЛНЕНИЕ
============================================================ */
/**
 * @param element  выбранный DOM-элемент
 * @param computed getComputedStyle, уже с учётом псевдоэлемента (может быть null)
 * @param selector стартовый селектор
 * @param info     варианты целей из index.js (может отсутствовать)
 */
export function populateProperties(element, computed, selector, info) {
    if (!panel) createPanel();
    panel.style.display = 'flex';

    el = element;
    targetInfo = info || null;
    pseudo = info?.pseudo || '';
    baseSelector = info?.baseSelector || rules.splitPseudo(selector || '').base;

    const opts = targetInfo?.options?.[pseudo] || [];
    sel = selector || opts[0]?.value || (baseSelector + pseudo);

    cs = computed || rules.computedFor(el, pseudo);

    els.empty.style.display = 'none';
    els.content.style.display = 'flex';
    els.selectorInput.value = sel;

    renderTargetRow();
    renderCrumbs();
    refresh();
}

/** Кнопки «Элемент / ::before / ::after» и список подходящих правил темы */
function renderTargetRow() {
    if (!els.targetRow) return;

    const pseudos = targetInfo?.pseudos?.length ? targetInfo.pseudos : [''];
    const options = targetInfo?.options?.[pseudo] || [];

    els.pseudoSeg.textContent = '';
    for (const p of pseudos) {
        const btn = h('button.vte-seg-btn', {
            type: 'button',
            text: p === '' ? 'Элемент' : p,
            title: p === ''
                ? 'Править сам элемент'
                : `Править псевдоэлемент ${p} — обычно там нарисована иконка`,
            on: { click: () => setPseudo(p) },
        });
        if (p === pseudo) btn.classList.add('active');
        els.pseudoSeg.appendChild(btn);
    }

    els.selectorPick.textContent = '';
    for (const opt of options) {
        const o = h('option', {
            value: opt.value,
            text: (opt.source === 'theme' ? '● ' : '○ ') + opt.label,
            title: opt.hint || opt.value,
        });
        if (opt.value === sel) o.selected = true;
        els.selectorPick.appendChild(o);
    }
    els.selectorPick.disabled = options.length < 2;

    const ruleLine = els.targetRow.querySelector('#vte-target-rule');
    if (ruleLine) ruleLine.style.display = options.length > 1 ? 'flex' : 'none';

    els.targetRow.style.display =
        (pseudos.length > 1 || options.length > 1) ? 'flex' : 'none';
}

function setPseudo(p) {
    if (p === pseudo) return;
    pseudo = p;
    const opts = targetInfo?.options?.[pseudo] || [];
    sel = opts[0]?.value || (baseSelector + pseudo);
    els.selectorInput.value = sel;
    syncVarLock();
    renderTargetRow();
    refresh();
    flash(p ? `Цель: ${p}` : 'Цель: сам элемент');
}

/**
 * Для псевдоэлемента и для группы переменные темы запрещены: они объявлены
 * в :root и действуют на весь интерфейс. Правишь одну иконку — меняются все.
 */
function syncVarLock() {
    if (!els.varsToggle) return;
    const lock = !!pseudo || !!groupMode;
    els.varsToggle.disabled = lock;
    els.varsToggle.checked = lock ? false : userWantsVars;
    useVars = lock ? false : userWantsVars;
    els.varsToggle.closest('.vte-check')?.classList.toggle('vte-check-locked', lock);
    if (els.varsToggle.parentElement) {
        els.varsToggle.parentElement.title = lock
            ? (groupMode
                ? 'Для группы переменные отключены: они меняют весь интерфейс'
                : 'Для псевдоэлемента переменные отключены: они меняют весь интерфейс')
            : '';
    }
}


function applySelectorChoice(value) {
    if (!value) return;
    sel = value;
    els.selectorInput.value = sel;
    renderTargetRow();
    syncVarLock();
    showVarHint('background-color');
    flash('Правка пойдёт в это правило');
}

function refresh() {
    if (!el) return;
    // Ключевой момент: у псевдоэлемента свои размеры и свой фон.
    cs = rules.computedFor(el, pseudo);
    renderColors();
    renderLayout();
    renderType();
    renderFx();
    if (iconMounted) iconTool.update({ selector: sel, pseudo, computed: cs, element: el });
    showVarHint('background-color');
}

function renderCrumbs() {
    els.crumbs.textContent = '';
    const chain = [];
    let cur = el;
    let depth = 0;
    while (cur && cur.nodeType === 1 && depth < 6 && cur !== document.body) {
        chain.unshift(cur);
        cur = cur.parentElement;
        depth++;
    }

    chain.forEach((node, i) => {
        if (i > 0) els.crumbs.appendChild(h('span.vte-crumb-sep', { text: '›' }));
        const label = node.id
            ? '#' + node.id
            : node.classList.length
                ? '.' + node.classList[0]
                : node.tagName.toLowerCase();

        const crumb = h('button.vte-crumb', {
            type: 'button',
            title: 'Выбрать этот элемент',
            text: label,
            on: {
                click: () => {
                    if (node === el) return;
                    const api = window.VisualThemeEditor;
                    if (api?.inspect) { api.inspect(node); return; }
                    const s = api?.selectorFor?.(node);
                    if (s) populateProperties(node, null, s);
                },
            },
        });
        if (node === el) crumb.classList.add('active');
        els.crumbs.appendChild(crumb);
    });
}
/* ============================================================
   ЗАМЕНА ТЕКСТА
============================================================ */

/** Быстрый CSS-селектор для элемента без обращения к генератору */
function quickSelector(node) {
    if (!node || node === document.body) return null;
    if (node.id && /^[a-z][\w-]{1,60}$/i.test(node.id)) {
        return '#' + (window.CSS?.escape ? CSS.escape(node.id) : node.id);
    }
    const cls = Array.from(node.classList)
        .filter(c => c && !c.startsWith('vte-') && !/^\d/.test(c))
        .slice(0, 2);
    const tag = node.tagName.toLowerCase();
    return cls.length
        ? tag + '.' + cls.map(c => window.CSS?.escape ? CSS.escape(c) : c).join('.')
        : tag;
}

/** Текст только прямых текстовых узлов элемента, без дочерних тегов */
function getDirectText(node) {
    let text = '';
    for (const child of node.childNodes) {
        if (child.nodeType === 3) text += child.textContent;
    }
    return text.trim();
}

/** Экранирование строки для CSS content: "..." */
function escapeContent(text) {
    return String(text || '')
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\A ')
        .replace(/\r/g, '');
}

/**
 * Определяет сценарий замены текста для текущей цели.
 * Возвращает { type: 'content'|'placeholder'|'element'|'none', ...данные }
 */
function detectTextScenario() {
    if (!el || !cs) return { type: 'none' };

    // 1. Псевдоэлемент — правим content напрямую
    if (pseudo) {
        const raw = String(cs.content || '');
        const match = raw.match(/^["'](.*)["']$/s);
        return { type: 'content', currentText: match ? match[1] : '' };
    }

    // 2. Поле ввода — подменяем плейсхолдер через ::after родителя
    const tag = el.tagName?.toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
        const parentEl = el.parentElement;
        return {
            type: 'placeholder',
            currentText: el.placeholder || '',
            parentEl,
            parentSel: quickSelector(parentEl),
            fontSize: cs.fontSize,
        };
    }

    // 3. Элемент с прямым текстом — font-size:0 + ::after
    const directText = getDirectText(el);
    if (directText) {
        const hasIconChildren = Array.from(el.children).some(
            c => c.tagName === 'I'
              || /\bfa-/.test(c.className || '')
              || /\bicon\b/i.test(c.className || '')
        );
        return {
            type: 'element',
            currentText: directText,
            fontSize: cs.fontSize,
            hasIconChildren,
        };
    }

    return { type: 'none' };
}

/**
 * По готовому сценарию и новому тексту собирает ruleset и вызывает onTextApply.
 */
function applyTextReplace(scenario, newText) {
    if (!onTextApply) return;

    const quoted  = `"${escapeContent(newText)}"`;
    const ruleset = [];

    if (scenario.type === 'content') {
        ruleset.push({ selector: sel, decls: { content: quoted } });
    }

    else if (scenario.type === 'placeholder') {
        const inputSel  = baseSelector;
        const parentSel = scenario.parentSel || baseSelector;

        // Скрываем родной плейсхолдер
        ruleset.push({
            selector: `${inputSel}::placeholder`,
            decls: { color: 'transparent', opacity: '0' },
        });
        // Родитель должен быть позиционирован
        ruleset.push({
            selector: parentSel,
            decls: { position: 'relative' },
        });
        // Свой плейсхолдер через ::after
        ruleset.push({
            selector: `${parentSel}::after`,
            decls: {
                content: quoted,
                display: 'block',
                position: 'absolute',
                left: '50%',
                top: '50%',
                transform: 'translate(-50%, -50%)',
                'pointer-events': 'none',
                'white-space': 'nowrap',
                overflow: 'hidden',
                'text-overflow': 'ellipsis',
                'z-index': '10',
                'font-style': 'italic',
                'font-size': scenario.fontSize || 'inherit',
                'font-family': 'inherit',
                color: 'inherit',
                opacity: '0.55',
            },
        });
        // Скрываем когда поле заполнено
        const hideChk = document.getElementById('vte-text-hide-filled');
        if (!hideChk || hideChk.checked) {
            ruleset.push({
                selector: `${parentSel}:has(${inputSel}:not(:placeholder-shown))::after`,
                decls: { opacity: '0', 'pointer-events': 'none' },
            });
        }
    }

    else if (scenario.type === 'element') {
        const elemSel  = baseSelector;
        const fontSize = scenario.fontSize || '14px';

        // Прячем оригинальный текст
        ruleset.push({
            selector: elemSel,
            decls: { 'font-size': '0', 'letter-spacing': '0' },
        });
        // Новый текст через ::after
        ruleset.push({
            selector: `${elemSel}::after`,
            decls: {
                content: quoted,
                'font-size': fontSize,
                'letter-spacing': 'normal',
                'font-style': 'inherit',
                'font-weight': 'inherit',
                'font-family': 'inherit',
                display: 'inline',
            },
        });
        // Восстанавливаем font-size дочерним иконкам
        if (scenario.hasIconChildren) {
            ruleset.push({
                selector: `${elemSel} > *`,
                decls: { 'font-size': fontSize },
            });
        }
    }

    if (ruleset.length) onTextApply(ruleset);
}

/** Строит секцию «Замена текста» для верха вкладки «Текст» */
function renderTextSection() {
    const scenario = detectTextScenario();
    if (scenario.type === 'none') return null;

    const labels = {
        content:     'Текст слоя (content)',
        placeholder: 'Плейсхолдер',
        element:     'Текст элемента',
    };

    const notes = {
        content:     'Меняет свойство content псевдоэлемента напрямую.',
        placeholder: 'Прячет встроенный плейсхолдер и подставляет свой через ::after на родителе.',
        element:     'Скрывает оригинальный текст через font-size:0 и выводит новый в ::after.',
    };

    const inputEl = h('textarea.vte-input', {
        rows: 2,
        spellcheck: false,
        placeholder: 'введите текст…',
        style: 'resize:vertical; min-height:40px; width:100%; box-sizing:border-box;',
    });
    inputEl.value = scenario.currentText || '';

    // Живой предпросмотр — только для псевдоэлементов (safe)
    if (scenario.type === 'content') {
        inputEl.addEventListener('input', () =>
            sendLive('content', `"${escapeContent(inputEl.value)}"`)
        );
    }

    const statusEl = h('span.vte-text-status', {
        style: 'font-size:11px; opacity:0.7; align-self:center;',
    });

    const hideRow = scenario.type === 'placeholder'
        ? h('label.vte-check', { style: 'margin-top:4px;' }, [
            h('input', { type: 'checkbox', id: 'vte-text-hide-filled', checked: true }),
            h('span', { text: 'Скрывать, если поле заполнено' }),
          ])
        : null;

    const iconWarn = (scenario.type === 'element' && scenario.hasIconChildren)
        ? h('small.vte-note', {
            text: '⚠ Внутри найдены иконки — font-size у них будет восстановлен автоматически.',
          })
        : null;

    const applyBtn = h('button.vte-btn.vte-btn-primary', {
        type: 'button',
        on: {
            click: () => {
                applyTextReplace(scenario, inputEl.value);
                statusEl.textContent = '✓ Применено';
                setTimeout(() => { statusEl.textContent = ''; }, 1800);
            },
        },
    }, [icon('fa-check'), h('span', { text: ' Применить' })]);

    const resetBtn = h('button.vte-btn.vte-btn-ghost', {
        type: 'button',
        title: 'Убрать все правила замены текста для этой цели',
        on: {
            click: () => {
                if (!onTextApply) return;
                const resets = buildResetRuleset(scenario);
                if (resets.length) onTextApply(resets, { reset: true });
                inputEl.value = scenario.currentText || '';
                statusEl.textContent = 'Сброшено';
                setTimeout(() => { statusEl.textContent = ''; }, 1800);
            },
        },
    }, [icon('fa-eraser'), h('span', { text: ' Сбросить' })]);

    return section(labels[scenario.type], [
        h('small.vte-note', { text: notes[scenario.type] }),
        inputEl,
        hideRow,
        iconWarn,
        h('div.vte-field-body', { style: 'margin-top:6px; gap:6px; flex-wrap:wrap;' }, [
            applyBtn,
            resetBtn,
            statusEl,
        ]),
    ].filter(Boolean));
}

/** Ruleset для сброса — пишет unset/'' в нужные свойства */
function buildResetRuleset(scenario) {
    const ruleset = [];
    if (scenario.type === 'content') {
        ruleset.push({ selector: sel, decls: { content: '""' } });
    }
    else if (scenario.type === 'placeholder') {
        const inputSel  = baseSelector;
        const parentSel = scenario.parentSel || baseSelector;
        ruleset.push({ selector: `${inputSel}::placeholder`,    decls: { color: '', opacity: '' } });
        ruleset.push({ selector: `${parentSel}::after`,          decls: { content: 'none' } });
        ruleset.push({ selector: `${parentSel}:has(${inputSel}:not(:placeholder-shown))::after`,
                       decls: { opacity: '' } });
    }
    else if (scenario.type === 'element') {
        const elemSel = baseSelector;
        ruleset.push({ selector: elemSel,              decls: { 'font-size': '', 'letter-spacing': '' } });
        ruleset.push({ selector: `${elemSel}::after`,  decls: { content: 'none' } });
        if (scenario.hasIconChildren) {
            ruleset.push({ selector: `${elemSel} > *`, decls: { 'font-size': '' } });
        }
    }
    return ruleset;
}

/* ============================================================
   ВКЛАДКА: ЦВЕТ
============================================================ */
function renderColors() {
    const pane = els.panes.colors;
    pane.textContent = '';

    const toIconTab = h('button.vte-btn', {
        type: 'button',
        title: 'Ссылка, SVG или data-URI, повтор, вписывание, позиция',
        on: { click: () => switchTab('icon') },
    }, [icon('fa-image'), h('span', { text: ' Открыть вкладку «Картинка»' })]);

    pane.append(
        colorField('Фон', 'background-color', cs.backgroundColor, false),
        h('small.vte-note', {
            text: '💡 Режим «Силуэт» на вкладке «Картинка»: цвет иконки — это поле «Фон» выше.',
        }),
        colorField('Текст', 'color', cs.color, false),
        colorField('Граница', 'border-color', cs.borderTopColor, false),

        section('Градиент фона', [
            colorField('Градиент', 'background-image',
                /gradient/i.test(cs.backgroundImage || '') ? cs.backgroundImage : '', true),
            h('small.vte-note', {
                text: 'Только для градиентов. Картинки, повтор, размер и позиция — на вкладке «Картинка».',
            }),
            h('div.vte-icon-actions', {}, [toIconTab]),
        ]),

        section('Наложение элемента', [
            selectRow('mix-blend-mode', 'mix-blend-mode', cs.mixBlendMode, [
                'normal', 'multiply', 'screen', 'overlay', 'soft-light',
                'hard-light', 'color-dodge', 'difference', 'luminosity',
            ]),
            h('small.vte-note', {
                text: 'Смешивает весь элемент с тем, что под ним. Наложение только для картинки — на вкладке «Картинка».',
            }),
        ]),
    );
}

function colorField(label, prop, value, allowGradient) {
    const initial = value || (allowGradient ? '' : 'rgba(0,0,0,1)');

    const swatch = h('button.vte-swatch', {
        type: 'button',
        title: 'Открыть палитру',
        style: `background:${initial || 'transparent'}`,
    });

    const hexInput = h('input.vte-hex', {
        type: 'text', spellcheck: false,
        value: allowGradient ? shortenValue(initial) : toHex(initial),
        title: allowGradient ? 'CSS-значение фона' : 'HEX-код',
    });

    const alphaRange = h('input.vte-range.vte-range-alpha', {
        type: 'range', min: 0, max: 100, step: 1,
        value: String(Math.round(getAlpha(initial) * 100)),
        title: 'Прозрачность',
    });

    const alphaVal = h('span.vte-range-val', {
        text: `${Math.round(getAlpha(initial) * 100)}%`,
    });

    let currentColor = initial;

    // live = true → только предпросмотр, CSS не переписывается
    const push = (v, live) => {
        currentColor = v;
        swatch.style.background = v || 'transparent';
        hexInput.value = allowGradient ? shortenValue(v) : toHex(v);
        if (!/gradient/i.test(String(v))) {
            const a = Math.round(getAlpha(v) * 100);
            alphaRange.value = String(a);
            alphaVal.textContent = `${a}%`;
        }
        live ? sendLive(prop, v || 'none') : commitNow(prop, v || 'none');
    };

    swatch.addEventListener('click', () => {
        if (!picker) return;
        picker.open({
            anchor: swatch,
            value: currentColor,
            allowGradient,
            onChange: (v) => push(v, true),
            onCommit: (v) => push(v, false),
        });
    });

    hexInput.addEventListener('change', () => {
        const raw = hexInput.value.trim();
        if (allowGradient) { push(raw, false); return; }
        const norm = normalizeHex(raw);
        if (!norm) { hexInput.value = toHex(currentColor); return; }
        push(withAlpha(norm, alphaRange.value / 100), false);
    });

    alphaRange.addEventListener('input', () => {
        alphaVal.textContent = `${alphaRange.value}%`;
        if (/gradient/i.test(String(currentColor))) return;
        push(withAlpha(currentColor, alphaRange.value / 100), true);
    });
    alphaRange.addEventListener('change', () => {
        if (/gradient/i.test(String(currentColor))) return;
        push(withAlpha(currentColor, alphaRange.value / 100), false);
    });

    return h('div.vte-field', {}, [
        h('label.vte-field-label', { text: label }),
        h('div.vte-field-body', {}, [
            swatch,
            hexInput,
            h('div.vte-alpha-wrap', {}, [alphaRange, alphaVal]),
        ]),
    ]);
}

/* ============================================================
   ВКЛАДКА: РАЗМЕР
============================================================ */
/** В цели лежит картинка или маска, а не глиф шрифта */
function layerHasImage() {
    if (!cs) return false;
    const bg = String(cs.backgroundImage || '');
    const mk = String(cs.maskImage || cs.webkitMaskImage || '');
    return /url\(|gradient/i.test(bg) || /url\(/i.test(mk);
}

/**
 * Размер иконки. Для картинки и силуэта это width + height + размер фона,
 * для глифа шрифта — font-size. Раньше всегда писался font-size, поэтому
 * у картинок менялась только высота строки, а сама иконка стояла на месте.
 */
function iconSizeRow() {
    const isImage = layerHasImage();
    const isMask = /url\(/i.test(String(cs.maskImage || cs.webkitMaskImage || ''));

    const start = isImage
        ? Math.round(parseFloat(cs.width) || parseFloat(cs.fontSize) || 20)
        : num(cs.fontSize);

    const range = h('input.vte-range', {
        type: 'range', min: 6, max: 128, step: 1, value: String(start),
    });
    const numInput = h('input.vte-num-inline', {
        type: 'number', min: 4, max: 512, step: 1, value: String(start),
    });
    const out = h('span.vte-range-val', { text: `${start}px` });

    const apply = (raw, live) => {
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) return;
        range.value = String(n);
        numInput.value = String(n);
        out.textContent = `${n}px`;

        if (!isImage) {
            live ? sendLive('font-size', `${n}px`) : commitNow('font-size', `${n}px`);
            return;
        }

        if (live) {
            sendLive('width', `${n}px`);
            sendLive('height', `${n}px`);
            sendLive(isMask ? 'mask-size' : 'background-size', 'contain');
            return;
        }

        const decls = {
            'width': `${n}px`,
            'height': `${n}px`,
            'min-width': `${n}px`,
            'min-height': `${n}px`,
        };
        if (isMask) {
            decls['mask-size'] = 'contain';
            decls['-webkit-mask-size'] = 'contain';
        } else {
            decls['background-size'] = 'contain';
        }
        writeDecls(sel, decls);
        setTimeout(refresh, 320);
    };

    range.addEventListener('input', () => apply(range.value, true));
    range.addEventListener('change', () => apply(range.value, false));
    numInput.addEventListener('change', () => apply(numInput.value, false));

    return h('div.vte-field', {}, [
        h('label.vte-field-label', { text: 'Размер иконки' }),
        h('div.vte-field-body', {}, [range, numInput, out]),
    ]);
}

function renderLayout() {
    const pane = els.panes.layout;
    pane.textContent = '';

    const isImage = layerHasImage();

    pane.append(
        section('Размер иконки', [
            iconSizeRow(),
            h('small.vte-note', {
                text: isImage
                    ? 'В цели картинка или силуэт: пишутся width, height и вписывание. '
                      + 'font-size на такую иконку не влияет — он только менял высоту строки.'
                    : 'В цели глиф шрифта: пишется font-size, размер иконки идёт за ним.',
            }),
            isImage
                ? sliderRow('font-size (текст)', 'font-size', num(cs.fontSize), 8, 64, 0.5, 'px')
                : null,
        ]),

        section('Габариты', [
            textRow('Ширина', 'width', cs.width),
            textRow('Высота', 'height', cs.height),
            textRow('Мин. ширина', 'min-width', cs.minWidth),
            textRow('Макс. ширина', 'max-width', cs.maxWidth),
        ]),

        section('Внутренние отступы (padding)', [
            boxRow('padding', {
                top: num(cs.paddingTop), right: num(cs.paddingRight),
                bottom: num(cs.paddingBottom), left: num(cs.paddingLeft),
            }),
        ]),

        section('Внешние отступы (margin)', [
            boxRow('margin', {
                top: num(cs.marginTop), right: num(cs.marginRight),
                bottom: num(cs.marginBottom), left: num(cs.marginLeft),
            }),
        ]),

        section('Рамка и углы', [
            sliderRow('Радиус углов', 'border-radius', num(cs.borderTopLeftRadius), 0, 80, 1, 'px'),
            sliderRow('Толщина рамки', 'border-width', num(cs.borderTopWidth), 0, 16, 1, 'px'),
            selectRow('Стиль рамки', 'border-style', cs.borderTopStyle, [
                'none', 'solid', 'dashed', 'dotted', 'double', 'groove', 'ridge',
            ]),
        ]),

        section('Положение', [
            selectRow('position', 'position', cs.position, [
                'static', 'relative', 'absolute', 'fixed', 'sticky',
            ]),
            transformRow(),
            sliderRow('z-index', 'z-index', parseInt(cs.zIndex) || 0, -20, 300, 1, ''),
            selectRow('display', 'display', cs.display, [
                'block', 'inline', 'inline-block', 'flex', 'inline-flex', 'grid', 'none',
            ]),
            selectRow('overflow', 'overflow', cs.overflow, [
                'visible', 'hidden', 'auto', 'scroll', 'clip',
            ]),
        ]),
    );
}

function transformRow() {
    const state = { x: 0, y: 0, scale: 100, rotate: 0 };
    Object.assign(state, parseTransform(cs.transform));

    const build = () => {
        const parts = [];
        if (state.x || state.y) parts.push(`translate(${state.x}px, ${state.y}px)`);
        if (state.scale !== 100) parts.push(`scale(${(state.scale / 100).toFixed(3)})`);
        if (state.rotate) parts.push(`rotate(${state.rotate}deg)`);
        return parts.length ? parts.join(' ') : 'none';
    };

    return h('div.vte-subgroup', {}, [
        groupSlider('Сдвиг X', state, 'x', -500, 500, 'px', 'transform', build),
        groupSlider('Сдвиг Y', state, 'y', -500, 500, 'px', 'transform', build),
        groupSlider('Масштаб', state, 'scale', 10, 300, '%', 'transform', build),
        groupSlider('Поворот', state, 'rotate', -180, 180, '°', 'transform', build),
    ]);
}

/* ============================================================
   ВКЛАДКА: ТЕКСТ
============================================================ */
function renderType() {
    const pane = els.panes.type;
    pane.textContent = '';

    const textSection = renderTextSection();
    if (textSection) pane.append(textSection);

    pane.append(
        section('Размер и ритм', [
            sliderRow('Размер шрифта', 'font-size', num(cs.fontSize), 8, 64, 0.5, 'px'),
            sliderRow('Межстрочный', 'line-height', lineHeightRatio(), 0.8, 3, 0.05, ''),
            sliderRow('Межбуквенный', 'letter-spacing', num(cs.letterSpacing), -4, 16, 0.1, 'px'),
            sliderRow('Отступ строки', 'text-indent', num(cs.textIndent), 0, 80, 1, 'px'),
            sliderRow('Отступ слов', 'word-spacing', num(cs.wordSpacing), -4, 24, 0.5, 'px'),
        ]),

        section('Начертание', [
            segRow('Насыщенность', 'font-weight', cs.fontWeight, [
                ['300', 'Light'], ['400', 'Normal'], ['500', 'Medium'],
                ['600', 'Semi'], ['700', 'Bold'], ['900', 'Black'],
            ]),
            segRow('Стиль', 'font-style', cs.fontStyle, [
                ['normal', 'Прямой'], ['italic', 'Курсив'],
            ]),
            segRow('Выравнивание', 'text-align', cs.textAlign, [
                ['left', 'Слева'], ['center', 'Центр'],
                ['right', 'Справа'], ['justify', 'По ширине'],
            ]),
            selectRow('Регистр', 'text-transform', cs.textTransform, [
                'none', 'uppercase', 'lowercase', 'capitalize',
            ]),
            selectRow('Подчёркивание', 'text-decoration-line', cs.textDecorationLine, [
                'none', 'underline', 'overline', 'line-through',
            ]),
            selectRow('Переносы', 'hyphens', cs.hyphens || 'manual', [
                'none', 'manual', 'auto',
            ]),
            selectRow('Перенос строк', 'white-space', cs.whiteSpace, [
                'normal', 'nowrap', 'pre', 'pre-wrap', 'pre-line',
            ]),
        ]),

        section('Семейство', [
            textRow('font-family', 'font-family', cs.fontFamily),
            h('small.vte-note', { text: 'Готовые шрифты Google — на вкладке «Шрифты»' }),
        ]),
    );
}


/* ============================================================
   ВКЛАДКА: ЭФФЕКТЫ
============================================================ */
function renderFx() {
    const pane = els.panes.fx;
    pane.textContent = '';

    const layerNote = pseudo
        ? h('div.vte-icon-stash', { style: 'display:flex; margin-bottom:6px' }, [
            h('span.vte-icon-stash-ic', {}, [icon('fa-circle-info')]),
            h('span.vte-icon-stash-text', {
                text: `Эффекты ниже применяются к слою ${pseudo} — содержимое элемента не затронуто.`,
            }),
          ])
        : h('small.vte-note', { style: 'margin-bottom:6px', text:
            'Эффекты применяются ко всему элементу. Чтобы затронуть только картинку — '
            + 'вынесите её в слой ::before или ::after на вкладке «Картинка».',
          });

    pane.append(
        layerNote,

        section('Прозрачность и фильтры', [
            sliderRow('Прозрачность', 'opacity', Math.round((parseFloat(cs.opacity) || 1) * 100),
                0, 100, 1, '%', 'ratio'),
            filterGroup(),
            sliderRow('Размытие фона', 'backdrop-filter', backdropBlurValue(), 0, 40, 1, 'px', 'blur'),
        ]),

        section('Тень блока', [shadowGroup()]),

        section('Тень текста', [
            textRow('text-shadow', 'text-shadow', cs.textShadow === 'none' ? '' : cs.textShadow),
        ]),

        section('Курсор и переходы', [
            selectRow('Курсор', 'cursor', cs.cursor, [
                'auto', 'default', 'pointer', 'text', 'move', 'grab', 'not-allowed', 'none',
            ]),
            sliderRow('Плавность', 'transition-duration',
                Math.round((parseFloat(cs.transitionDuration) || 0) * 1000), 0, 1200, 10, 'ms'),
            selectRow('Кривая', 'transition-timing-function', cs.transitionTimingFunction, [
                'ease', 'ease-in', 'ease-out', 'ease-in-out', 'linear',
                'cubic-bezier(0.34, 1.56, 0.64, 1)',
            ]),
            selectRow('Клики сквозь', 'pointer-events', cs.pointerEvents, ['auto', 'none']),
        ]),
    );
}


function filterGroup() {
    const state = parseFilter(cs.filter);

    const build = () => {
        const parts = [];
        if (state.blur) parts.push(`blur(${state.blur}px)`);
        if (state.brightness !== 100) parts.push(`brightness(${state.brightness}%)`);
        if (state.saturate !== 100) parts.push(`saturate(${state.saturate}%)`);
        if (state.contrast !== 100) parts.push(`contrast(${state.contrast}%)`);
        if (state.hue) parts.push(`hue-rotate(${state.hue}deg)`);
        if (state.grayscale) parts.push(`grayscale(${state.grayscale}%)`);
        return parts.length ? parts.join(' ') : 'none';
    };

    return h('div.vte-subgroup', {}, [
        groupSlider('Размытие', state, 'blur', 0, 30, 'px', 'filter', build),
        groupSlider('Яркость', state, 'brightness', 0, 250, '%', 'filter', build),
        groupSlider('Насыщенность', state, 'saturate', 0, 300, '%', 'filter', build),
        groupSlider('Контраст', state, 'contrast', 0, 250, '%', 'filter', build),
        groupSlider('Оттенок', state, 'hue', 0, 360, '°', 'filter', build),
        groupSlider('Ч/б', state, 'grayscale', 0, 100, '%', 'filter', build),
    ]);
}

function shadowGroup() {
    const state = parseShadow(cs.boxShadow);

    const build = () => {
        const inset = state.inset ? 'inset ' : '';
        return `${inset}${state.x}px ${state.y}px ${state.blur}px ${state.spread}px ${state.color}`;
    };

    const swatch = h('button.vte-swatch', {
        type: 'button', title: 'Цвет тени',
        style: `background:${state.color}`,
    });

    swatch.addEventListener('click', () => {
        picker?.open({
            anchor: swatch,
            value: state.color,
            allowGradient: false,
            onChange: (v) => { state.color = v; swatch.style.background = v; sendLive('box-shadow', build()); },
            onCommit: (v) => { state.color = v; swatch.style.background = v; commitNow('box-shadow', build()); },
        });
    });

    const insetToggle = h('input', {
        type: 'checkbox', checked: state.inset,
        on: { change: (e) => { state.inset = e.target.checked; commitNow('box-shadow', build()); } },
    });

    return h('div.vte-subgroup', {}, [
        h('div.vte-field', {}, [
            h('label.vte-field-label', { text: 'Цвет' }),
            h('div.vte-field-body', {}, [swatch, h('span.vte-muted', { text: state.color })]),
        ]),
        groupSlider('Сдвиг X', state, 'x', -60, 60, 'px', 'box-shadow', build),
        groupSlider('Сдвиг Y', state, 'y', -60, 60, 'px', 'box-shadow', build),
        groupSlider('Размытие', state, 'blur', 0, 80, 'px', 'box-shadow', build),
        groupSlider('Растяжение', state, 'spread', -30, 40, 'px', 'box-shadow', build),
        h('label.vte-check', {}, [insetToggle, h('span', { text: 'Внутренняя тень' })]),
    ]);
}

/* ============================================================
   КОНСТРУКТОРЫ СТРОК
============================================================ */
function section(title, children) {
    const body = h('div.vte-section-body', {}, children);
    const chev = h('span.vte-section-chev', {}, [icon('fa-chevron-down')]);
    const head = h('button.vte-section-head', {
        type: 'button',
        on: {
            click: () => {
                const open = body.style.display !== 'none';
                body.style.display = open ? 'none' : 'flex';
                chev.classList.toggle('vte-rotated', open);
            },
        },
    }, [h('span', { text: title }), chev]);

    return h('div.vte-section', {}, [head, body]);
}

/** Ползунок внутри группы (transform / filter / box-shadow) */
function groupSlider(label, state, key, min, max, unit, property, build) {
    const range = h('input.vte-range', {
        type: 'range', min, max, step: 1, value: String(state[key]),
    });
    const out = h('span.vte-range-val', { text: `${state[key]}${unit}` });

    range.addEventListener('input', () => {
        state[key] = Number(range.value);
        out.textContent = `${state[key]}${unit}`;
        sendLive(property, build());
    });
    range.addEventListener('change', () => {
        state[key] = Number(range.value);
        out.textContent = `${state[key]}${unit}`;
        commitNow(property, build());
    });

    return h('div.vte-field', {}, [
        h('label.vte-field-label', { text: label }),
        h('div.vte-field-body', {}, [range, out]),
    ]);
}

function sliderRow(label, prop, value, min, max, step, unit, transform) {
    const v = Number(value) || 0;
    const range = h('input.vte-range', {
        type: 'range', min, max, step, value: String(v),
    });
    const out = h('span.vte-range-val', { text: `${v}${unit}` });
    const numInput = h('input.vte-num-inline', {
        type: 'number', min, max, step, value: String(v),
    });

    const format = (n) => {
        if (transform === 'ratio') return (n / 100).toFixed(2);
        if (transform === 'blur') return n ? `blur(${n}px)` : 'none';
        return unit ? `${n}${unit}` : String(n);
    };

    const apply = (raw, live) => {
        const n = Number(raw);
        if (!Number.isFinite(n)) return;
        range.value = String(n);
        numInput.value = String(n);
        out.textContent = `${n}${unit}`;

        const outVal = format(n);
        if (live) {
            sendLive(prop, outVal);
            if (prop === 'backdrop-filter') sendLive('-webkit-backdrop-filter', outVal);
        } else {
            commitNow(prop, outVal);
            if (prop === 'backdrop-filter') commitNow('-webkit-backdrop-filter', outVal);
        }
    };

    range.addEventListener('input', () => apply(range.value, true));
    range.addEventListener('change', () => apply(range.value, false));
    numInput.addEventListener('change', () => apply(numInput.value, false));

    return h('div.vte-field', {}, [
        h('label.vte-field-label', { text: label }),
        h('div.vte-field-body', {}, [range, numInput, out]),
    ]);
}

function textRow(label, prop, value) {
    const input = h('input.vte-input', {
        type: 'text', spellcheck: false, value: value || '',
        placeholder: 'не задано',
    });
    input.addEventListener('change', () => {
        const v = input.value.trim();
        commitNow(prop, v === '' ? 'unset' : v);
    });
    return h('div.vte-field', {}, [
        h('label.vte-field-label', { text: label }),
        h('div.vte-field-body', {}, [input]),
    ]);
}

function selectRow(label, prop, value, options) {
    const current = String(value || '').trim();
    const list = options.includes(current) ? options : [current, ...options];

    const select = h('select.vte-select', {}, list.map(opt => {
        const o = h('option', { value: opt, text: opt || '(пусто)' });
        if (opt === current) o.selected = true;
        return o;
    }));

    select.addEventListener('change', () => commitNow(prop, select.value));

    return h('div.vte-field', {}, [
        h('label.vte-field-label', { text: label }),
        h('div.vte-field-body', {}, [select]),
    ]);
}

function segRow(label, prop, value, options) {
    const current = String(value || '').trim();
    const group = h('div.vte-seg');

    options.forEach(([val, text]) => {
        const btn = h('button.vte-seg-btn', {
            type: 'button', text, title: val,
            on: {
                click: () => {
                    group.querySelectorAll('.vte-seg-btn').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    commitNow(prop, val);
                },
            },
        });
        if (val === current) btn.classList.add('active');
        group.appendChild(btn);
    });

    return h('div.vte-field', {}, [
        h('label.vte-field-label', { text: label }),
        h('div.vte-field-body', {}, [group]),
    ]);
}

function boxRow(prop, values) {
    const linked = h('input', { type: 'checkbox', checked: false });
    const inputs = {};
    const sides = [['top', 'Сверху'], ['right', 'Справа'], ['bottom', 'Снизу'], ['left', 'Слева']];

    const grid = h('div.vte-box-grid');
    for (const [side, title] of sides) {
        const input = h('input.vte-box-input', {
            type: 'number', step: 1, value: String(values[side] ?? 0), title,
        });
        input.addEventListener('change', () => {
            const v = Number(input.value) || 0;
            if (linked.checked) {
                for (const [s2] of sides) {
                    inputs[s2].value = String(v);
                    commitNow(`${prop}-${s2}`, `${v}px`);
                }
            } else {
                commitNow(`${prop}-${side}`, `${v}px`);
            }
        });
        inputs[side] = input;
        grid.appendChild(h('div.vte-box-cell', {}, [
            h('span.vte-box-label', { text: title }),
            input,
        ]));
    }

    return h('div.vte-box', {}, [
        grid,
        h('label.vte-check.vte-box-link', {}, [linked, h('span', { text: 'Все стороны вместе' })]),
    ]);
}

/* ============================================================
   ОТПРАВКА НАРУЖУ
   sendLive  — идёт только в предпросмотр, CSS не переписывается
   commitNow — реальная запись в CSS темы
============================================================ */
function sendLive(property, value) {
    if (!sel) return;
    onPropertyChange(sel, property, value, { useVariables: useVars, live: true });
}
/** Записать сразу набор свойств в указанный селектор */
function writeDecls(target, decls) {
    if (!target) return;
    if (onBatchChange) { onBatchChange(target, decls); return; }
    for (const [p, v] of Object.entries(decls)) {
        onPropertyChange(target, p, v === '' ? '' : (v || 'unset'), { useVariables: false });
    }
}

/**
 * Раздаёт суффикс каждому селектору списка.
 * '#a, .b' + '::before' → '#a::before, .b::before'
 * Наивная склейка давала '#a, .b::before' — правило доезжало только до .b.
 */
function distributeSuffix(selector, suffix) {
    const s = String(selector || '').trim();
    if (!s || !suffix) return '';

    return s
        .split(',')
        .map(part => part.trim().replace(/:{1,2}(?:before|after)\s*$/i, '').trim())
        .filter(Boolean)
        .map(part => part + suffix)
        .join(', ');
}
function normalizeSel(selector) {
    return String(selector || '')
        .split(',')
        .map(p => p.trim())
        .filter(Boolean)
        .join(', ');
}

/**
 * Селектор без псевдоэлементов — сам элемент.
 * '#a::after, .b::after' → '#a, .b'
 * Нужно, чтобы дописать хосту position:relative под наклейку.
 */
function baseOf(selector) {
    return String(selector || '')
        .split(',')
        .map(p => p.trim().replace(/:{1,2}(?:before|after)\s*$/i, '').trim())
        .filter(Boolean)
        .join(', ');
}

/** '#a, .b::after' → '#a:hover, .b:hover::after' */
function withHover(selector) {
    const s = String(selector || '');
    if (!s || /:hover/.test(s)) return null;

    const parts = s
        .split(',')
        .map(one => {
            const { base, pseudo: p } = rules.splitPseudo(one.trim());
            if (!base) return null;
            return base + ':hover' + (p || '');
        })
        .filter(Boolean);

    return parts.length ? parts.join(', ') : null;
}

function commitNow(property, value) {
    if (!sel) return;
    clearTimeout(timers.get(property));
    timers.set(property, setTimeout(() => {
        onPropertyChange(sel, property, value, { useVariables: useVars });
        showVarHint(property);
    }, DEBOUNCE));
}

function showVarHint(property) {
    if (!els.varHint) return;
    els.varHint.textContent = '';
    els.varHint.classList.remove('vte-var-active', 'vte-var-inplace');
    els.varHint.title = '';

    const info = onRequestVarInfo(sel, property, { useVariables: useVars }) || {};

    if (info.mode === 'variable' && info.name) {
        els.varHint.append(
            icon('fa-link'),
            h('span', { text: ' Переменная ' }),
            h('code', { text: info.name })
        );
        els.varHint.classList.add('vte-var-active');
        return;
    }

    if (info.mode === 'in-place') {
        els.varHint.append(
            icon('fa-pen'),
            h('span', { text: ` Правлю тему, стр. ${info.line}` })
        );
        els.varHint.classList.add('vte-var-inplace');
        els.varHint.title = info.hasProperty
            ? `Меняю значение прямо в правиле ${info.selector}`
            : `Дописываю свойство в правило ${info.selector}`;
        return;
    }

    if (!useVars) {
        els.varHint.append(icon('fa-file-code'), h('span', { text: ' Пишу правило напрямую' }));
        return;
    }

    els.varHint.append(icon('fa-plus'), h('span', { text: ' Новое правило в авто-блоке' }));
}

function flash(text) {
    if (!els.status) return;
    els.status.textContent = text;
    els.status.classList.add('vte-status-show');
    clearTimeout(flash._t);
    flash._t = setTimeout(() => {
        els.status.classList.remove('vte-status-show');
        els.status.textContent = '';
    }, 2000);
}

/* ============================================================
   ПЕРЕТАСКИВАНИЕ / ЗАЩИТА
============================================================ */
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

/* ============================================================
   ПАРСЕРЫ ЗНАЧЕНИЙ
============================================================ */
function num(v) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function lineHeightRatio() {
    const lh = parseFloat(cs.lineHeight);
    if (!Number.isFinite(lh)) return 1.5;
    const fs = parseFloat(cs.fontSize) || 16;
    return String(cs.lineHeight).includes('px')
        ? Math.round((lh / fs) * 100) / 100
        : lh;
}

function backdropBlurValue() {
    const v = cs.backdropFilter || cs.webkitBackdropFilter || '';
    const m = v.match(/blur\(([\d.]+)px\)/);
    return m ? Number(m[1]) : 0;
}

function parseFilter(value) {
    const state = { blur: 0, brightness: 100, saturate: 100, contrast: 100, hue: 0, grayscale: 0 };
    if (!value || value === 'none') return state;
    const pick = (name) => {
        const m = value.match(new RegExp(`${name}\\(([\\d.]+)`));
        return m ? Number(m[1]) : null;
    };
    state.blur = pick('blur') ?? 0;
    state.brightness = pick('brightness') ?? 100;
    state.saturate = pick('saturate') ?? 100;
    state.contrast = pick('contrast') ?? 100;
    state.hue = pick('hue-rotate') ?? 0;
    state.grayscale = pick('grayscale') ?? 0;
    ['brightness', 'saturate', 'contrast'].forEach(k => {
        if (state[k] <= 5) state[k] = Math.round(state[k] * 100);
    });
    return state;
}

function parseShadow(value) {
    const state = { x: 0, y: 4, blur: 12, spread: 0, color: 'rgba(0, 0, 0, 0.5)', inset: false };
    if (!value || value === 'none') return state;

    state.inset = /inset/.test(value);
    const colorMatch = value.match(/(rgba?\([^)]+\)|#[0-9a-f]{3,8})/i);
    if (colorMatch) state.color = colorMatch[1];

    const nums = value
        .replace(/(rgba?\([^)]+\)|#[0-9a-f]{3,8}|inset)/gi, '')
        .match(/-?[\d.]+px/g);
    if (nums) {
        const parsed = nums.map(n => parseFloat(n));
        state.x = parsed[0] ?? 0;
        state.y = parsed[1] ?? 0;
        state.blur = parsed[2] ?? 0;
        state.spread = parsed[3] ?? 0;
    }
    return state;
}

function parseTransform(value) {
    const out = { x: 0, y: 0, scale: 100, rotate: 0 };
    if (!value || value === 'none') return out;

    const mtx = value.match(/^matrix\(([^)]+)\)$/);
    if (mtx) {
        const p = mtx[1].split(',').map(Number);
        out.x = Math.round(p[4] || 0);
        out.y = Math.round(p[5] || 0);
        out.scale = Math.round(Math.hypot(p[0], p[1]) * 100) || 100;
        out.rotate = Math.round(Math.atan2(p[1], p[0]) * 180 / Math.PI);
        return out;
    }

    const tr = value.match(/translate\(\s*(-?[\d.]+)px\s*(?:,\s*(-?[\d.]+)px)?/);
    if (tr) { out.x = Math.round(Number(tr[1])); out.y = Math.round(Number(tr[2] || 0)); }
    const sc = value.match(/scale\(\s*([\d.]+)/);
    if (sc) out.scale = Math.round(Number(sc[1]) * 100);
    const rot = value.match(/rotate\(\s*(-?[\d.]+)deg/);
    if (rot) out.rotate = Math.round(Number(rot[1]));
    return out;
}

function toHex(value) {
    const p = parseRgba(value);
    if (!p) return '#000000';
    return '#' + [p.r, p.g, p.b]
        .map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0'))
        .join('');
}

function getAlpha(value) {
    const p = parseRgba(value);
    return p ? p.a : 1;
}

function withAlpha(value, a) {
    const p = parseRgba(value) || { r: 0, g: 0, b: 0 };
    const alpha = Math.round(Math.max(0, Math.min(1, a)) * 1000) / 1000;
    return alpha >= 1
        ? `rgb(${p.r}, ${p.g}, ${p.b})`
        : `rgba(${p.r}, ${p.g}, ${p.b}, ${alpha})`;
}

function parseRgba(value) {
    const v = String(value ?? '').trim();
    if (!v || /gradient|url\(/i.test(v)) return null;

    let m = v.match(/^#([0-9a-f]{3,8})$/i);
    if (m) {
        let hex = m[1];
        if (hex.length === 3 || hex.length === 4) hex = hex.split('').map(c => c + c).join('');
        return {
            r: parseInt(hex.slice(0, 2), 16),
            g: parseInt(hex.slice(2, 4), 16),
            b: parseInt(hex.slice(4, 6), 16),
            a: hex.length >= 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
        };
    }

    m = v.match(/^rgba?\(([^)]+)\)$/i);
    if (m) {
        const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
        return { r: p[0] || 0, g: p[1] || 0, b: p[2] || 0, a: p[3] == null ? 1 : p[3] };
    }
    return null;
}

function normalizeHex(v) {
    if (!v) return null;
    let s = v.trim();
    if (!s.startsWith('#')) s = '#' + s;
    if (/^#[0-9a-f]{3}$/i.test(s)) {
        return '#' + s.slice(1).split('').map(c => c + c).join('').toLowerCase();
    }
    if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
    if (/^#[0-9a-f]{8}$/i.test(s)) return s.slice(0, 7).toLowerCase();
    return null;
}

function shortenValue(v) {
    const s = String(v || '');
    return s.length > 60 ? s.slice(0, 57) + '…' : s;
}
/* ============================================================
   РЕЖИМ ГРУППЫ (правка по шаблону)

   Вызывается из index.js сразу после populateProperties.
   Хлебные крошки в этом режиме скрыты: они показывали бы путь
   одного элемента-представителя и вводили в заблуждение.
============================================================ */
export function setGroup(name) {
    if (!panel) return;
    groupMode = name || null;

    const bar = ensureGroupBar();

    if (groupMode) {
        els.groupText.textContent =
            `Правим группу «${groupMode}». Каждое изменение попадёт на все `
            + 'элементы шаблона сразу.';
        bar.style.display = 'flex';
        if (els.crumbs) els.crumbs.style.display = 'none';
    } else {
        bar.style.display = 'none';
        if (els.crumbs) els.crumbs.style.display = 'flex';
    }

    syncVarLock();
    showVarHint('background-color');
}

export function isGroupMode() {
    return !!groupMode;
}

function ensureGroupBar() {
    if (els.groupBar && els.groupBar.isConnected) return els.groupBar;

    els.groupText = h('span.vte-group-text', { text: '' });

    els.groupExit = h('button.vte-group-exit', {
        type: 'button',
        title: 'Выйти из режима группы и вернуться к выбору одного элемента',
        on: {
            click: () => {
                setGroup(null);
                onPickAgain();
            },
        },
    }, [icon('fa-crosshairs'), h('span', { text: ' Один элемент' })]);

    els.groupBar = h('div.vte-group-bar', { style: 'display:none' }, [
        h('span.vte-group-ic', {}, [icon('fa-layer-group')]),
        els.groupText,
        els.groupExit,
    ]);

    // Полоска встаёт над строкой селектора, чтобы её было видно сразу
    els.selectorRow.insertAdjacentElement('beforebegin', els.groupBar);
    return els.groupBar;
}
