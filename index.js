// ===== Visual Theme Editor for SillyTavern =====
const MODULE = 'visual-theme-editor';
const BASE = `/scripts/extensions/third-party/${MODULE}`;

/* ============================================================
   ПОДКЛЮЧЕНИЕ К ST
============================================================ */
let _script = null, _extApi = null, _power = null;

async function connectST() {
    const tryImport = async (path) => {
        try { return await import(path); } catch { return null; }
    };
    _extApi = await tryImport('../../../extensions.js');
    _script = await tryImport('../../../../script.js');
    _power  = await tryImport('../../../power-user.js');
}

function ctx() {
    try { return window.SillyTavern?.getContext?.() ?? null; } catch { return null; }
}

function settingsRoot() {
    const s = ctx()?.extensionSettings
        ?? _extApi?.extension_settings
        ?? (window.extension_settings ??= {});
    if (!s[MODULE] || typeof s[MODULE] !== 'object') s[MODULE] = {};
    return s[MODULE];
}

const DEFAULTS = {
    enabled: true,
    highlightColor: '#4ea1ff',
    showCode: true,
    useVariables: true,
    liveApply: true,
    hotkey: true,
    pickerOnStart: false,           // включать прицел сразу вместе с редактором
    pickOnce: true,                 // после выбора элемента прицел выключается
    hotkeyToggle: 'Alt+Shift+KeyE', // включить / выключить редактор
    hotkeyPick: 'Alt+Shift+KeyS',   // включить / выключить выбор элемента
};

function cfg() {
    const s = settingsRoot();
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (s[k] === undefined) s[k] = v;
    }
    return s;
}

function persist() {
    try { ctx()?.saveSettingsDebounced?.(); }
    catch { _extApi?.saveSettingsDebounced?.(); }
}

/* ============================================================
   ЗАГРУЗКА МОДУЛЕЙ
============================================================ */
let selector, inspector, generator, fonts, editor, picker;

async function loadModules() {
    const load = (name) => import(`${BASE}/modules/${name}.js`);
    [selector, inspector, generator, fonts, editor, picker] = await Promise.all([
        load('selector'),
        load('inspector'),
        load('cssGenerator'),
        load('fontManager'),
        load('codeEditor'),
        load('colorPicker'),
    ]);
}

/* ============================================================
   СОСТОЯНИЕ
============================================================ */
let active = false;
let customCSS = '';
let history = [];
let future = [];
const HISTORY_LIMIT = 60;

/* ============================================================
   ЧТЕНИЕ / ЗАПИСЬ ПОЛЬЗОВАТЕЛЬСКОГО CSS
============================================================ */
function cssTextarea() {
    return document.getElementById('customCSS');
}

function readCSS() {
    const ta = cssTextarea();
    if (ta) return ta.value || '';
    try { if (_power?.power_user?.custom_css != null) return _power.power_user.custom_css; } catch {}
    return document.getElementById('custom-style')?.textContent || '';
}

function writeCSS(css, opts = {}) {
    customCSS = css;

    const ta = cssTextarea();
    if (ta) {
        ta.value = css;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
        applyDirect(css);
        try {
            if (_power?.power_user) {
                _power.power_user.custom_css = css;
                persist();
            }
        } catch {}
    }

    if (!opts.skipEditor && editor?.isOpen?.()) {
        editor.setContent(css, { silent: true });
    }
    scheduleParse(css);
}

/** Разбор CSS на переменные — тяжёлая операция, откладываем её */
let parseTimer = null;
function scheduleParse(css) {
    clearTimeout(parseTimer);
    parseTimer = setTimeout(() => generator.parse(css), 400);
}


function applyDirect(css) {
    let style = document.getElementById('custom-style');
    if (!style) {
        style = document.createElement('style');
        style.id = 'custom-style';
        document.head.appendChild(style);
    }
    style.textContent = css;
}

/* ============================================================
   ИСТОРИЯ
============================================================ */
function pushHistory(css) {
    if (history[history.length - 1] === css) return;
    history.push(css);
    if (history.length > HISTORY_LIMIT) history.shift();
    future.length = 0;
    updateHistoryButtons();
}

function undo() {
    if (history.length < 2) return;
    future.push(history.pop());
    writeCSS(history[history.length - 1]);
    updateHistoryButtons();
    toast('Отменено');
}

function redo() {
    if (!future.length) return;
    const css = future.pop();
    history.push(css);
    writeCSS(css);
    updateHistoryButtons();
    toast('Возвращено');
}

function updateHistoryButtons() {
    const u = document.getElementById('vte-undo');
    const r = document.getElementById('vte-redo');
    if (u) u.disabled = history.length < 2;
    if (r) r.disabled = future.length === 0;
}

/* ============================================================
   ЖИЗНЕННЫЙ ЦИКЛ РЕДАКТОРА
============================================================ */
function toggleEditor() {
    active ? deactivate() : activate();
}

function activate() {
    if (active) return;
    active = true;

    customCSS = readCSS();
    generator.parse(customCSS);
    picker.setSwatches(generator.getVariables().map(v => ({ name: v.name, value: v.value })));
    history = [customCSS];
    future = [];

    document.body.classList.add('vte-active');

    inspector.createPanel();
    selector.setHighlightColor(cfg().highlightColor);

    if (cfg().showCode) {
        editor.showPanel();
        editor.setContent(customCSS, { silent: true });
    }

    updateHistoryButtons();
    updateToggleUI();
    updatePickUI();

    // Прицел больше не включается сам: только если это явно разрешено в настройках
    if (cfg().pickerOnStart) {
        startPicking();
    } else {
        toast(`Редактор включён. Выбор элемента — ${comboLabel(cfg().hotkeyPick)}`);
    }
}

function deactivate() {
    if (!active) return;
    active = false;

    selector.deactivate();
    inspector.hidePanel();
    editor.hidePanel();
    fonts.stopPreview?.();
    clearPreviewStyles();

    document.body.classList.remove('vte-active');
    updateToggleUI();
    updatePickUI();
    toast('Редактор выключен');
}

/* ---------- Режим выбора элемента: живёт отдельно от редактора ---------- */
function togglePicking() {
    selector.isActive() ? stopPicking() : startPicking();
}

function startPicking() {
    if (!active) {
        activate();
        if (selector.isActive()) return; // pickerOnStart уже включил
    }
    if (selector.isActive()) return;

    inspector.createPanel();
    selector.setHighlightColor(cfg().highlightColor);
    selector.activate();
    toast('Выберите элемент. Esc — выйти из режима выбора.');
}

function stopPicking() {
    if (!selector.isActive()) return;
    selector.deactivate();
}

function isPicking() {
    return !!selector?.isActive?.();
}

function clearPreviewStyles() {
    document.getElementById('vte-live-preview')?.remove();
    previewStyle = null;
    previewRules.clear();
}

/* ============================================================
   ЖИВОЙ ПРЕДПРОСМОТР
============================================================ */
let previewRules = new Map();
let previewStyle = null;

function previewProperty(sel, prop, value) {
    if (!cfg().liveApply) return;
    if (!previewStyle || !previewStyle.isConnected) {
        previewStyle = document.createElement('style');
        previewStyle.id = 'vte-live-preview';
        document.head.appendChild(previewStyle);
    }
    if (!previewRules.has(sel)) previewRules.set(sel, new Map());
    if (value === '' || value == null) previewRules.get(sel).delete(prop);
    else previewRules.get(sel).set(prop, value);

    let css = '';
    for (const [s, decls] of previewRules) {
        if (!decls.size) continue;
        css += `${s} {\n`;
        for (const [p, v] of decls) css += `    ${p}: ${v} !important;\n`;
        css += '}\n';
    }
    previewStyle.textContent = css;
}

function dropPreviewFor(sel) {
    previewRules.delete(sel);
    if (previewStyle && !previewRules.size) previewStyle.textContent = '';
}

/* ============================================================
   ОБРАБОТЧИКИ МОДУЛЕЙ
============================================================ */
function handleElementSelected(el) {
    const sel = generator.generateSelector(el);
    if (!sel) {
        toast('Не удалось определить селектор для этого элемента');
        return;
    }
    inspector.populateProperties(el, getComputedStyle(el), sel);

    // По умолчанию прицел выключается сразу после выбора, чтобы не мешал работать
    if (cfg().pickOnce) stopPicking();
}

let commitTimer = null;

function handlePropertyChange(sel, property, value, opts = {}) {
    if (property === '__reset__') {
        const next = generator.updateRule(customCSS, sel, '__reset__', '');
        dropPreviewFor(sel);
        pushHistory(next);
        writeCSS(next);
        toast('Правила для элемента убраны');
        return;
    }

    previewProperty(sel, property, value);

    clearTimeout(commitTimer);
    commitTimer = setTimeout(() => {
        const next = generator.updateRule(customCSS, sel, property, value, {
            useVariables: opts.useVariables ?? cfg().useVariables,
        });
        if (next === customCSS) return;
        pushHistory(next);
        writeCSS(next);
    }, 260);
}

function handleVarInfoRequest(sel, property) {
    if (!cfg().useVariables) return null;
    try { return generator.findVariable(sel, property); } catch { return null; }
}

function handleFontSelected(payload) {
    let next = generator.addFontImport(customCSS, payload.importUrl);

    // font-family и font-weight пишем ТОЛЬКО обычным правилом.
    // Через переменные темы это ломает системные расчёты SillyTavern.
    next = generator.updateRule(next, payload.selector, 'font-family', payload.stack, {
        useVariables: false,
    });

    if (payload.weight && payload.weight !== 400) {
        next = generator.updateRule(next, payload.selector, 'font-weight', String(payload.weight), {
            useVariables: false,
        });
    }

    pushHistory(next);
    writeCSS(next);
    toast(`Шрифт ${payload.family} применён`);
}

function handleCodeChange(css) {
    const errors = generator.validate(css);
    if (errors.length) {
        toast(`В CSS ${errors.length} замечаний, смотрите панель кода`, 'warning');
    }
    pushHistory(css);
    writeCSS(css, { skipEditor: true });
    previewRules.clear();
    if (previewStyle) previewStyle.textContent = '';
}

/* ============================================================
   МИНИ-ХЕЛПЕР DOM
============================================================ */
function h(tagSpec, attrs, children) {
    const idMatch = tagSpec.match(/#([\w-]+)/);
    const clsList = (tagSpec.match(/\.[\w-]+/g) || []).map(s => s.slice(1));
    const tag = (tagSpec.match(/^[\w-]+/) || ['div'])[0];

    const el = document.createElement(tag);
    if (idMatch) el.id = idMatch[1];
    if (clsList.length) el.className = clsList.join(' ');

    if (attrs) {
        for (const [k, v] of Object.entries(attrs)) {
            if (v == null || v === false) continue;
            if (k === 'text') { el.textContent = v; continue; }
            if (k === 'style') { el.style.cssText = v; continue; }
            if (k === 'dataset') { Object.assign(el.dataset, v); continue; }
            if (k === 'on') {
                for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
                continue;
            }
            if (k in el && typeof el[k] !== 'object' && k !== 'list') {
                try { el[k] = v; continue; } catch {}
            }
            el.setAttribute(k, v === true ? '' : v);
        }
    }
    for (const c of [].concat(children || [])) {
        if (c == null || c === false) continue;
        el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
}

function icon(name) {
    return h('i', { className: `fa-solid ${name}` });
}

function toast(text, kind = 'info') {
    try { window.toastr?.[kind]?.(text, 'Theme Editor', { timeOut: 2600 }); }
    catch { console.log('[VTE]', text); }
}

/* ============================================================
   ПУНКТ В МЕНЮ-ПАЛОЧКЕ
============================================================ */
function mountWandItem() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return;

    if (!document.getElementById('vte-wand')) {
        menu.appendChild(h('div#vte-wand.list-group-item.flex-container.flexGap5.interactable', {
            tabIndex: 0,
            on: { click: toggleEditor },
        }, [
            h('div.fa-solid.fa-wand-magic-sparkles.extensionsMenuExtensionButton'),
            h('span#vte-wand-label', { text: 'Визуальный редактор темы' }),
        ]));
    }

    if (!document.getElementById('vte-wand-pick')) {
        menu.appendChild(h('div#vte-wand-pick.list-group-item.flex-container.flexGap5.interactable', {
            tabIndex: 0,
            on: { click: togglePicking },
        }, [
            h('div.fa-solid.fa-crosshairs.extensionsMenuExtensionButton'),
            h('span#vte-wand-pick-label', { text: 'Выбрать элемент для правки' }),
        ]));
    }

    updateToggleUI();
    updatePickUI();
}

function updateToggleUI() {
    const label = document.getElementById('vte-wand-label');
    if (label) {
        label.textContent = active
            ? 'Выключить редактор темы'
            : 'Визуальный редактор темы';
    }
    const btn = document.getElementById('vte-settings-toggle');
    if (btn) {
        btn.textContent = '';
        btn.append(
            icon(active ? 'fa-circle-stop' : 'fa-wand-magic-sparkles'),
            h('span', { text: active ? ' Выключить редактор' : ' Включить редактор' })
        );
        btn.classList.toggle('vte-btn-danger', active);
    }
}

function updatePickUI() {
    const picking = isPicking();

    const label = document.getElementById('vte-wand-pick-label');
    if (label) {
        label.textContent = picking
            ? 'Выключить выбор элемента'
            : 'Выбрать элемент для правки';
    }

    const btn = document.getElementById('vte-settings-pick');
    if (btn) {
        btn.textContent = '';
        btn.append(
            icon(picking ? 'fa-ban' : 'fa-crosshairs'),
            h('span', { text: picking ? ' Выключить выбор' : ' Выбрать элемент' })
        );
        btn.classList.toggle('vte-btn-danger', picking);
    }
}
/* ============================================================
   СОЧЕТАНИЯ КЛАВИШ: РАЗБОР И ПОДПИСЬ
============================================================ */
const MOD_KEYS = ['Control', 'Alt', 'Shift', 'Meta'];

/** Собирает строку вида "Alt+Shift+KeyE" из события клавиатуры */
function comboFromEvent(e) {
    if (MOD_KEYS.includes(e.key)) return null;
    const parts = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.metaKey) parts.push('Meta');
    if (!e.code) return null;
    parts.push(e.code);
    return parts.join('+');
}

/** Человеческая подпись: "Alt + Shift + E" */
function comboLabel(combo) {
    const raw = String(combo || '').trim();
    if (!raw) return 'не задано';
    return raw.split('+').map(part => {
        if (part.startsWith('Key')) return part.slice(3);
        if (part.startsWith('Digit')) return part.slice(5);
        if (part.startsWith('Numpad')) return 'Num ' + part.slice(6);
        if (part === 'Escape') return 'Esc';
        if (part === 'Meta') return 'Cmd';
        if (part === 'Control') return 'Ctrl';
        return part;
    }).join(' + ');
}

function matchCombo(e, combo) {
    const raw = String(combo || '').trim();
    if (!raw) return false;
    const parts = raw.split('+');
    const code = parts[parts.length - 1];
    if (e.code !== code) return false;
    return e.ctrlKey === parts.includes('Ctrl')
        && e.altKey === parts.includes('Alt')
        && e.shiftKey === parts.includes('Shift')
        && e.metaKey === parts.includes('Meta');
}

/* ============================================================
   ПАНЕЛЬ НАСТРОЕК
============================================================ */
function mountSettingsPanel() {
    const host = document.getElementById('extensions_settings2')
        || document.getElementById('extensions_settings');
    if (!host || document.getElementById('vte-settings')) return;

    const body = h('div.inline-drawer-content#vte-settings-body', { style: 'display:none' });
    const chevron = h('div.inline-drawer-icon.fa-solid.fa-circle-chevron-down.down');

    const header = h('div.inline-drawer-header', {
        style: 'cursor:pointer',
        on: {
            click: () => {
                const open = body.style.display !== 'none';
                body.style.display = open ? 'none' : 'block';
                chevron.classList.toggle('fa-circle-chevron-down', open);
                chevron.classList.toggle('fa-circle-chevron-up', !open);
                chevron.classList.toggle('down', open);
                chevron.classList.toggle('up', !open);
            },
        },
    }, [
        h('b', {}, [icon('fa-wand-magic-sparkles'), h('span', { text: ' Визуальный редактор темы' })]),
        chevron,
    ]);

    const toggleBtn = h('button#vte-settings-toggle.menu_button.vte-wide-btn', {
        type: 'button',
        on: { click: toggleEditor },
    });

    const pickBtn = h('button#vte-settings-pick.menu_button.vte-wide-btn', {
        type: 'button',
        on: { click: togglePicking },
    });

    const check = (key, label, hint, onAfter) => {
        const input = h('input', {
            type: 'checkbox',
            checked: !!cfg()[key],
            on: {
                change: (e) => {
                    cfg()[key] = e.target.checked;
                    persist();
                    onAfter?.(e.target.checked);
                },
            },
        });
        return h('div.vte-settings-row', {}, [
            h('label.checkbox_label', {}, [input, h('span', { text: label })]),
            hint ? h('small.vte-settings-hint', { text: hint }) : null,
        ]);
    };

    const options = h('div.vte-settings-options', {}, [
        check('useVariables', 'Приоритет CSS-переменных',
            'Менять значения в :root, если подходящая переменная уже есть в теме'),
        check('liveApply', 'Мгновенный предпросмотр',
            'Изменения видны сразу, до записи в CSS'),
        check('showCode', 'Показывать панель кода', null, (v) => {
            if (!active) return;
            v ? editor.showPanel() : editor.hidePanel();
        }),
        check('pickerOnStart', 'Включать выбор элемента вместе с редактором',
            'По умолчанию выключено: редактор открывается, а курсор остаётся обычным'),
        check('pickOnce', 'Выключать выбор после клика',
            'Выбрали элемент — прицел сам отпускает интерфейс'),
        check('hotkey', 'Горячие клавиши включены', null),
    ]);

    /* ---- Переназначение сочетаний ---- */
    const hotkeyRow = (key, label, hint) => {
        const btn = h('button.vte-hotkey-input.menu_button', {
            type: 'button',
            title: 'Нажмите, затем введите сочетание. Backspace — очистить, Esc — отмена.',
            text: comboLabel(cfg()[key]),
        });

        const reset = () => {
            btn.classList.remove('vte-capturing');
            btn.textContent = comboLabel(cfg()[key]);
        };

        btn.addEventListener('click', () => {
            btn.classList.add('vte-capturing');
            btn.textContent = 'нажмите сочетание…';
            btn.focus();
        });

        btn.addEventListener('keydown', (e) => {
            if (!btn.classList.contains('vte-capturing')) return;
            e.preventDefault();
            e.stopPropagation();

            if (e.key === 'Escape') { reset(); return; }
            if (e.key === 'Backspace' || e.key === 'Delete') {
                cfg()[key] = '';
                persist();
                reset();
                return;
            }
            const combo = comboFromEvent(e);
            if (!combo) return;
            cfg()[key] = combo;
            persist();
            reset();
            toast(`Сочетание сохранено: ${comboLabel(combo)}`);
        });

        btn.addEventListener('blur', reset);

        return h('div.vte-settings-row.vte-hotkey-row', {}, [
            h('label.vte-settings-label', { text: label }),
            btn,
            hint ? h('small.vte-settings-hint', { text: hint }) : null,
        ]);
    };

    const hotkeys = h('div.vte-settings-options', {}, [
        h('div.vte-settings-subtitle', { text: 'Горячие клавиши' }),
        hotkeyRow('hotkeyToggle', 'Редактор темы', 'Открыть или закрыть панели редактора'),
        hotkeyRow('hotkeyPick', 'Выбор элемента', 'Включить или выключить прицел'),
    ]);

    const colorInput = h('input.vte-color-input', {
        type: 'color',
        value: cfg().highlightColor,
        on: {
            input: (e) => {
                cfg().highlightColor = e.target.value;
                persist();
                selector?.setHighlightColor?.(e.target.value);
            },
        },
    });

    const colorRow = h('div.vte-settings-row', {}, [
        h('label.vte-settings-label', { text: 'Цвет рамки выбора' }),
        colorInput,
    ]);

    const undoBtn = h('button#vte-undo.menu_button', {
        type: 'button', disabled: true, on: { click: undo },
    }, [icon('fa-rotate-left'), h('span', { text: ' Отменить' })]);

    const redoBtn = h('button#vte-redo.menu_button', {
        type: 'button', disabled: true, on: { click: redo },
    }, [icon('fa-rotate-right'), h('span', { text: ' Вернуть' })]);

    const historyRow = h('div.vte-settings-actions', {}, [undoBtn, redoBtn]);

    const codeBtn = h('button.menu_button', {
        type: 'button',
        on: {
            click: () => {
                editor.showPanel();
                editor.setContent(readCSS(), { silent: true });
            },
        },
    }, [icon('fa-code'), h('span', { text: ' Открыть код' })]);

    const cleanBtn = h('button.menu_button', {
        type: 'button',
        on: { click: removeAutoBlock },
    }, [icon('fa-broom'), h('span', { text: ' Убрать авто-блок' })]);

    const exportBtn = h('button.menu_button', {
        type: 'button',
        on: { click: exportCSS },
    }, [icon('fa-download'), h('span', { text: ' Скачать CSS' })]);

    const toolsRow = h('div.vte-settings-actions', {}, [codeBtn, cleanBtn, exportBtn]);

    const varsBox = h('div#vte-settings-vars.vte-settings-vars');
    const varsBtn = h('button.menu_button', {
        type: 'button',
        on: { click: () => renderVarsSummary(varsBox) },
    }, [icon('fa-list'), h('span', { text: ' Показать переменные темы' })]);

    const hint = h('small.vte-settings-note', {}, [
        icon('fa-circle-info'),
        h('span', {
            text: ' Расширение правит переменные темы, а новые правила складывает ' +
                  'в помеченный блок в конце CSS. Ваш код между маркерами не переписывается.',
        }),
    ]);

    body.append(toggleBtn, pickBtn, options, hotkeys, colorRow, historyRow, toolsRow, varsBtn, varsBox, hint);

    const drawer = h('div#vte-settings.inline-drawer', {}, [header, body]);
    host.appendChild(drawer);

    updateToggleUI();
    updatePickUI();
    updateHistoryButtons();
}

function renderVarsSummary(box) {
    generator.parse(readCSS());
    const list = generator.getVariables();
    box.textContent = '';

    if (!list.length) {
        box.appendChild(h('div.vte-settings-empty', {
            text: 'В теме не найдено CSS-переменных. Расширение будет создавать свои.',
        }));
        return;
    }

    box.appendChild(h('div.vte-vars-head', {
        text: `Найдено переменных: ${list.length}`,
    }));

    const table = h('div.vte-vars-table');
    for (const v of list.slice(0, 200)) {
        const isColor = /^(#|rgba?\(|hsla?\()/i.test(v.value);
        table.appendChild(h('div.vte-vars-row', {}, [
            isColor
                ? h('span.vte-vars-swatch', { style: `background:${v.value}` })
                : h('span.vte-vars-swatch.vte-vars-swatch-empty'),
            h('code.vte-vars-name', { text: v.name }),
            h('span.vte-vars-value', { text: v.value, title: v.value }),
            h('span.vte-vars-uses', {
                text: v.usedIn ? `×${v.usedIn}` : '—',
                title: v.usedIn ? `Используется в ${v.usedIn} объявлениях` : 'Не используется',
            }),
        ]));
    }
    box.appendChild(table);
}

function removeAutoBlock() {
    const css = readCSS();
    const START = '/* ==== VTE:AUTO START — не редактируйте вручную ==== */';
    const END = '/* ==== VTE:AUTO END ==== */';
    const s = css.indexOf(START);
    const e = css.indexOf(END);
    if (s === -1 || e === -1) {
        toast('Авто-блок не найден', 'info');
        return;
    }
    const next = (css.slice(0, s) + css.slice(e + END.length)).replace(/\n{3,}/g, '\n\n');
    pushHistory(next);
    writeCSS(next);
    toast('Авто-блок удалён');
}

function exportCSS() {
    const blob = new Blob([readCSS()], { type: 'text/css' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: 'custom-theme.css' });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ============================================================
   ГОРЯЧИЕ КЛАВИШИ
============================================================ */
function bindHotkeys() {
    document.addEventListener('keydown', (e) => {
        // Пока переназначаем клавишу — глобальные сочетания молчат
        if (document.activeElement?.classList?.contains('vte-capturing')) return;
        if (!cfg().hotkey) return;

        if (matchCombo(e, cfg().hotkeyToggle)) {
            e.preventDefault();
            toggleEditor();
            return;
        }
        if (matchCombo(e, cfg().hotkeyPick)) {
            e.preventDefault();
            togglePicking();
            return;
        }
        if (!active) return;

        const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');

        // Esc в режиме выбора обрабатывает сам selector: гасит только прицел
        if (e.key === 'Escape' && !inField) {
            if (isPicking()) return;
            deactivate();
            return;
        }
        if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ' && !inField) {
            e.preventDefault();
            e.shiftKey ? redo() : undo();
        }
    }, true);
}

/* ============================================================
   ОТСЛЕЖИВАНИЕ DOM
============================================================ */
function watchDom() {
    let timer = null;
    const isOurs = (n) =>
        n.nodeType === 1 && ((n.id || '').startsWith('vte-') ||
            (n.className || '').toString().includes('vte-'));

    const obs = new MutationObserver((records) => {
        const added = records.flatMap(r => Array.from(r.addedNodes));
        if (added.length && added.every(isOurs)) return;

        clearTimeout(timer);
        timer = setTimeout(() => {
            mountWandItem();
            mountSettingsPanel();
        }, 220);
    });

    const attach = (id, opts) => {
        const el = document.getElementById(id);
        if (el) obs.observe(el, opts);
    };

    setTimeout(() => {
        attach('extensionsMenu', { childList: true });
        attach('extensions_settings2', { childList: true });
        attach('extensions_settings', { childList: true });
    }, 800);
}

function watchThemeSwitch() {
    const ev = _script?.eventSource ?? ctx()?.eventSource;
    const et = _script?.event_types ?? ctx()?.eventTypes ?? ctx()?.event_types;
    if (!ev || !et) return;

    const resync = () => {
        const css = readCSS();
        if (css === customCSS) return;
        customCSS = css;
        generator.parse(css);
        history = [css];
        future = [];
        updateHistoryButtons();
        if (editor?.isOpen?.()) editor.setContent(css, { silent: true });
    };

    [et.SETTINGS_UPDATED, et.SETTINGS_LOADED, et.APP_READY].forEach(name => {
        if (name) { try { ev.on(name, () => setTimeout(resync, 300)); } catch {} }
    });
}

/* ============================================================
   СТАРТ
============================================================ */
async function boot() {
    await connectST();

    try {
        await loadModules();
    } catch (err) {
        console.error('[VTE] Не удалось загрузить модули:', err);
        return;
    }

    generator.init();
    picker.init({ swatches: [] });

    selector.init({
        onElementSelected: handleElementSelected,
        onStateChange: (on) => {
            updatePickUI();
            if (!on && active) toast('Выбор элемента выключен');
        },
        highlightColor: cfg().highlightColor,
    });

    inspector.init({
        onPropertyChange: handlePropertyChange,
        onRequestVarInfo: handleVarInfoRequest,
        onFontsTabMount: (el) => fonts.mount(el),
        onPickAgain: () => startPicking(),
        onUndo: undo,
        onRedo: redo,
        picker,
    });

    fonts.init({
        onFontSelected: handleFontSelected,
    });

    editor.init({
        onCodeChange: handleCodeChange,
        onValidate: (css) => generator.validate(css),
    });

    customCSS = readCSS();
    generator.parse(customCSS);

    bindHotkeys();
    watchDom();
    watchThemeSwitch();

    [300, 900, 2000, 4000].forEach(delay => setTimeout(() => {
        mountWandItem();
        mountSettingsPanel();
    }, delay));

    window.VisualThemeEditor = {
        toggle: toggleEditor,
        activate,
        deactivate,
        isActive: () => active,
        startPicking,
        stopPicking,
        togglePicking,
        isPicking,
        getCSS: readCSS,
        setCSS: (css) => { pushHistory(css); writeCSS(css); },
        undo,
        redo,
        variables: () => { generator.parse(readCSS()); return generator.getVariables(); },
        selectorFor: (el) => generator.generateSelector(el),
    };

    console.log('[VTE] Visual Theme Editor готов ✓');
}
/* ============================================================
   ЗАПУСК
============================================================ */
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
    boot();
}
