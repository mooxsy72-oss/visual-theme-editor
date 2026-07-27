// modules/inspector.js
// Панель свойств выбранного элемента.
// Ключевая идея: пока пользователь тянет ползунок, наружу летят "живые"
// события (только предпросмотр). Тяжёлая запись в CSS — один раз, по отпусканию.

let onPropertyChange = null;
let onRequestVarInfo = null;
let onFontsTabMount = null;
let onPickAgain = null;
let onUndo = null;
let onRedo = null;
let picker = null;

let panel = null;
let els = {};

let el = null;
let sel = '';
let cs = null;
let useVars = true;
let fontsMounted = false;

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
    onRequestVarInfo = options.onRequestVarInfo || (() => null);
    onFontsTabMount = options.onFontsTabMount || (() => {});
    onPickAgain = options.onPickAgain || (() => {});
    onUndo = options.onUndo || (() => {});
    onRedo = options.onRedo || (() => {});
    picker = options.picker || null;
}

export function isVariableMode() {
    return useVars;
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
            iconBtn('fa-crosshairs', 'Выбрать другой элемент', () => onPickAgain()),
            iconBtn('fa-rotate-left', 'Отменить (Ctrl+Z)', () => onUndo()),
            iconBtn('fa-rotate-right', 'Вернуть (Ctrl+Shift+Z)', () => onRedo()),
            iconBtn('fa-window-minimize', 'Свернуть', () => panel.classList.toggle('vte-collapsed')),
            iconBtn('fa-xmark', 'Закрыть', hidePanel, 'vte-icon-btn-close'),
        ]),
    ]);

    els.selectorInput = h('input#vte-selector.vte-selector-input', {
        type: 'text', readOnly: true, spellcheck: false,
        title: 'CSS-селектор выбранного элемента',
    });

    els.selectorRow = h('div.vte-selector-row', {}, [
        h('span.vte-selector-ic', {}, [icon('fa-code')]),
        els.selectorInput,
        iconBtn('fa-copy', 'Скопировать селектор', () => {
            navigator.clipboard?.writeText(els.selectorInput.value);
            flash('Селектор скопирован');
        }),
    ]);

    els.crumbs = h('div#vte-crumbs.vte-crumbs');

    els.varsToggle = h('input', {
        type: 'checkbox', checked: true,
        on: {
            change: (e) => {
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
        ['type', 'Текст', 'fa-font'],
        ['fx', 'Эффекты', 'fa-sparkles'],
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
            title: 'Убрать все правила, созданные для этого элемента',
            on: { click: () => { commitNow('__reset__', ''); flash('Правила элемента убраны'); } },
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
        els.selectorRow, els.crumbs, els.modeRow, els.tabs, paneWrap,
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
}

/* ============================================================
   ЗАПОЛНЕНИЕ
============================================================ */
export function populateProperties(element, computed, selector) {
    if (!panel) createPanel();
    panel.style.display = 'flex';

    el = element;
    cs = computed;
    sel = selector;

    els.empty.style.display = 'none';
    els.content.style.display = 'flex';
    els.selectorInput.value = selector;

    renderCrumbs();
    refresh();
}

function refresh() {
    if (!el) return;
    cs = getComputedStyle(el);
    renderColors();
    renderLayout();
    renderType();
    renderFx();
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
                    const s = window.VisualThemeEditor?.selectorFor?.(node);
                    if (s) populateProperties(node, getComputedStyle(node), s);
                },
            },
        });
        if (node === el) crumb.classList.add('active');
        els.crumbs.appendChild(crumb);
    });
}

/* ============================================================
   ВКЛАДКА: ЦВЕТ
============================================================ */
function renderColors() {
    const pane = els.panes.colors;
    pane.textContent = '';

    pane.append(
        colorField('Фон', 'background-color', cs.backgroundColor, false),
        colorField('Текст', 'color', cs.color, false),
        colorField('Граница', 'border-color', cs.borderTopColor, false),
        section('Фоновая заливка', [
            colorField('Градиент / картинка', 'background-image',
                cs.backgroundImage === 'none' ? '' : cs.backgroundImage, true),
            selectRow('Режим наложения', 'mix-blend-mode', cs.mixBlendMode, [
                'normal', 'multiply', 'screen', 'overlay', 'soft-light',
                'hard-light', 'color-dodge', 'difference', 'luminosity',
            ]),
            selectRow('Повтор фона', 'background-repeat', cs.backgroundRepeat, [
                'no-repeat', 'repeat', 'repeat-x', 'repeat-y',
            ]),
            selectRow('Размер фона', 'background-size', cs.backgroundSize, [
                'auto', 'cover', 'contain', '100% 100%',
            ]),
            textRow('Позиция фона', 'background-position', cs.backgroundPosition),
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
function renderLayout() {
    const pane = els.panes.layout;
    pane.textContent = '';

    pane.append(
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
            h('small.vte-note', {
                text: 'Готовые шрифты Google — на вкладке «Шрифты»',
            }),
        ]),
    );
}

/* ============================================================
   ВКЛАДКА: ЭФФЕКТЫ
============================================================ */
function renderFx() {
    const pane = els.panes.fx;
    pane.textContent = '';

    pane.append(
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

    if (!useVars) {
        els.varHint.append(icon('fa-file-code'), h('span', { text: ' Пишу правило напрямую' }));
        els.varHint.classList.remove('vte-var-active');
        return;
    }

    const info = onRequestVarInfo(sel, property);
    if (info?.name) {
        els.varHint.append(
            icon('fa-link'),
            h('span', { text: ' Переменная ' }),
            h('code', { text: info.name })
        );
        els.varHint.classList.add('vte-var-active');
    } else {
        els.varHint.append(icon('fa-plus'), h('span', { text: ' Новое правило в авто-блоке' }));
        els.varHint.classList.remove('vte-var-active');
    }
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
