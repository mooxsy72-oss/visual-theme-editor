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
    editInPlace: false,             // экспериментально: править код темы на месте
    followCode: true,               // панель кода сама прыгает к новым строкам
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
let selector, inspector, generator, fonts, editor, picker, rules, templates;

async function loadModules() {
    const load = (name) => import(`${BASE}/modules/${name}.js`);
    [selector, inspector, generator, fonts, editor, picker, rules, templates] = await Promise.all([
        load('selector'),
        load('inspector'),
        load('cssGenerator'),
        load('fontManager'),
        load('codeEditor'),
        load('colorPicker'),
        load('cssRules'),
        load('templates'),
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

    // Отложенные правки надо выбросить, иначе они сработают уже после
    // отмены и вернут всё назад.
    dropPendingCommits();

    future.push(history.pop());
    const css = history[history.length - 1];

    // Слой предпросмотра держит значения с !important и перекрывает
    // откаченный CSS. Без этой строки отмена не видна на экране.
    clearPreviewStyles();

    writeCSS(css);
    updateHistoryButtons();
    refreshInspector();
    toast('Отменено');
}

function redo() {
    if (!future.length) return;

    dropPendingCommits();

    const css = future.pop();
    history.push(css);
    clearPreviewStyles();
    writeCSS(css);
    updateHistoryButtons();
    refreshInspector();
    toast('Возвращено');
}

/**
 * После отмены поля панели обязаны перечитать значения из CSS.
 * Небольшая задержка нужна, чтобы браузер успел применить новый стиль.
 */
let refreshTimer = null;
function refreshInspector() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
        try { inspector.refreshValues?.(); } catch {}
    }, 120);
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

    // Сначала дописываем всё, что ещё висит в очереди, и только потом
    // снимаем слой предпросмотра. Иначе значения, не успевшие попасть
    // в CSS, просто исчезали с экрана.
    flushCommits();

    selector.deactivate();
    inspector.hidePanel();
    editor.hidePanel();
    templates?.stopCollect?.();
    templates?.hidePanel?.();
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
    flushCommits();
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
/* ---------- Индекс правил темы, пересобирается при смене CSS ---------- */
let ruleIndex = null;
let ruleIndexFor = null;

function getRuleIndex() {
    const css = customCSS || readCSS();
    if (!ruleIndex || ruleIndexFor !== css) {
        ruleIndex = rules.buildIndex(css);
        ruleIndexFor = css;
    }
    return ruleIndex;
}

function shortLabel(v) {
    const s = String(v).replace(/\s+/g, ' ').trim();
    return s.length > 46 ? s.slice(0, 43) + '…' : s;
}

/** Селекторы из темы, которые реально попадают в этот элемент/псевдоэлемент */
function themeSelectorsFor(el, pseudo) {
    const out = [];
    let matches = [];
    try {
        matches = rules.findMatches(getRuleIndex(), el, pseudo || null) || [];
    } catch (err) {
        console.warn('[VTE] Не удалось разобрать CSS темы:', err);
        return out;
    }
    for (const m of matches) {
        if (m.part.states.length) continue;            // :hover вслепую не правим
        if (!rules.isContextActive(m.rule)) continue;  // @media, который сейчас не действует
        const value = m.part.raw;
        if (out.some(o => o.value === value)) continue;
        out.push({
            value,
            label: shortLabel(value),
            source: 'theme',
            hint: rules.describeRule(m.rule),
        });
        if (out.length >= 5) break;
    }
    return out;
}

/** Сам элемент ничего не рисует, а псевдоэлемент рисует? Значит правим псевдо. */
function isVisuallyEmpty(el) {
    try {
        const cs = getComputedStyle(el);
        const fs = parseFloat(cs.fontSize) || 0;
        const textHidden = fs < 4
            || cs.color === 'transparent'
            || /rgba\(0, 0, 0, 0\)/.test(cs.color || '');
        const noText = !String(el.textContent || '').trim() || textHidden;
        const noBg = cs.backgroundImage === 'none'
            && (!cs.backgroundColor || /transparent|rgba\(0, 0, 0, 0\)/.test(cs.backgroundColor));
        return noText && noBg;
    } catch {
        return false;
    }
}

function cssEsc(v) {
    if (window.CSS?.escape) return CSS.escape(v);
    return String(v).replace(/([^\w-])/g, '\\$1');
}

/**
 * Собирает селектор, который целится ТОЛЬКО в этот элемент и при этом
 * сильнее правил темы. Без усиления `#rightNavDrawerIcon::after` (10001)
 * проигрывает `#top-settings-holder .drawer-icon::after` (10101),
 * и правка просто не видна.
 */
function strongSelectorFor(el, base, pseudo, competitors) {
    if (!base) return null;

    const need = competitors.reduce(
        (max, c) => Math.max(max, rules.specificityScore(c)), 0);

    const hits = (s) => {
        try { return el.matches(s) ? document.querySelectorAll(s).length : 0; }
        catch { return 0; }
    };
    const stronger = (s) => rules.specificityScore(s + pseudo) > need;

    if (hits(base) === 1 && stronger(base)) {
        return { value: base + pseudo, unique: true };
    }

    // Добавляем родительские id: каждый поднимает специфичность на 10000
    const ids = [];
    let p = el.parentElement;
    while (p && p !== document.documentElement && ids.length < 4) {
        if (p.id && /^[a-z][\w-]{1,60}$/i.test(p.id)) ids.push('#' + cssEsc(p.id));
        p = p.parentElement;
    }

    let cur = base;
    for (const id of ids) {
        cur = `${id} ${cur}`;
        if (hits(cur) === 1 && stronger(cur)) {
            return { value: cur + pseudo, unique: true };
        }
    }

    // Не хватило — доводим собственными классами элемента
    let withClasses = cur;
    for (const c of Array.from(el.classList)) {
        if (c.startsWith('vte-')) continue;
        withClasses += '.' + cssEsc(c);
        if (hits(withClasses) === 1 && stronger(withClasses)) {
            return { value: withClasses + pseudo, unique: true };
        }
    }

    const best = hits(withClasses) ? withClasses : (hits(cur) ? cur : base);
    return { value: best + pseudo, unique: hits(best) === 1 };
}

function buildTargets(el) {
    const base = generator.generateSelector(el);
    if (!base) return null;

    // Слои предлагаем всегда: ::before и ::after — это законные цели,
    // даже если сейчас они ничего не рисуют. Вкладка «Картинка» сама
    // допишет content, когда положит туда изображение.
    const pseudos = ['', '::before', '::after'];

    const options = {};
    for (const p of pseudos) {
        const theme = themeSelectorsFor(el, p);
        const list = theme.slice();

        const own = strongSelectorFor(el, base, p, theme.map(t => t.value));
        if (own && !list.some(o => o.value === own.value)) {
            list.push({
                value: own.value,
                label: (own.unique ? 'только этот элемент — ' : 'этот элемент — ')
                    + shortLabel(own.value),
                source: 'generated',
                hint: own.unique
                    ? 'Новое правило, затронет только выбранный элемент'
                    : 'Новое правило, но селектор попадает и в другие элементы',
            });
        }
        options[p] = list;
    }

    // Сам элемент ничего не рисует, а псевдоэлемент рисует — целимся в псевдо
    let pseudo = '';
    const painted = ['::before', '::after'].filter(p => rules.hasPseudo(el, p));
    if (painted.length && isVisuallyEmpty(el)) pseudo = painted[painted.length - 1];

    return { element: el, pseudos, pseudo, baseSelector: base, options };
}

function inspectElement(el) {
    if (!el || el.nodeType !== 1) return;

    const info = buildTargets(el);
    if (!info) {
        toast('Не удалось определить селектор для этого элемента');
        return;
    }

    const start = info.options[info.pseudo]?.[0]?.value
        || (info.baseSelector + info.pseudo);

    inspector.populateProperties(el, rules.computedFor(el, info.pseudo), start, info);

    if (info.pseudo) {
        toast(`Целюсь в ${info.pseudo} — картинка нарисована там`);
    }
}

function handleElementSelected(el) {
    // Идёт набор шаблона — элемент уходит в группу, панель свойств не трогаем
    // и прицел не гасим: человек набирает несколько элементов подряд.
    if (templates?.isCollecting?.() && templates.handlePicked(el)) return;

    inspectElement(el);
    // По умолчанию прицел выключается сразу после выбора, чтобы не мешал работать
    if (cfg().pickOnce) stopPicking();
}

/* ============================================================
   ПРАВКА ГРУППЫ ЭЛЕМЕНТОВ ПО ШАБЛОНУ

   У группы нет одного элемента, поэтому значения для полей панели
   читаются с первого найденного элемента-представителя, а запись
   идёт в общий селектор со списком через запятую.
============================================================ */
function editTemplateGroup(groupSelector, tpl) {
    if (!groupSelector) return;
    if (!active) activate();

    // Представитель: первый элемент, который реально есть на странице
    let sample = null;
    for (const part of groupSelector.split(',')) {
        try { sample = document.querySelector(part.trim()); } catch { sample = null; }
        if (sample) break;
    }

    if (!sample) {
        toast('Ни один элемент шаблона сейчас не найден на странице', 'warning');
        return;
    }

    // Псевдоэлемент нужно дописать КАЖДОМУ селектору списка.
    // 'a, b' + '::after' → 'a::after, b::after'.
    // Простая склейка давала 'a, b::after' и правило доезжало только до b.
    const spread = (p) => p
        ? groupSelector.split(',').map(s => s.trim()).filter(Boolean)
            .map(s => s + p).join(', ')
        : groupSelector;

    const pseudos = ['', '::before', '::after'];
    const options = {};
    for (const p of pseudos) {
        options[p] = [{
            value: spread(p),
            label: `группа «${tpl?.name || 'шаблон'}» — ${tpl?.items?.length || 0} шт.`,
            source: 'generated',
            hint: spread(p),
        }];
    }

    const info = {
        element: sample,
        pseudos,
        pseudo: '',
        baseSelector: groupSelector,
        options,
    };

    inspector.populateProperties(sample, rules.computedFor(sample, ''), groupSelector, info);
    inspector.setGroup(tpl?.name || 'шаблон');
    toast(`Правим группу «${tpl?.name || 'шаблон'}» — правки пойдут на все элементы`);
}

function toggleTemplates() {
    if (!active) activate();
    templates.togglePanel();
}

/* ============================================================
   ОТЛОЖЕННАЯ ЗАПИСЬ В CSS

   Раньше здесь был один таймер на всё расширение. Если панель успевала
   отправить два свойства подряд (backdrop-filter + -webkit-backdrop-filter,
   четыре стороны padding, ширина + высота иконки), clearTimeout убивал
   предыдущую запись, и до CSS доезжало только последнее свойство.

   Теперь правки складываются в очередь и пишутся одним пакетом —
   один шаг истории, ничего не теряется.
============================================================ */
let commitTimer = null;
let revealTimer = null;
const pendingCommits = new Map();   // селектор -> Map(свойство -> {value, useVariables})
const COMMIT_DELAY = 260;

function queueCommit(sel, property, value, useVariables) {
    if (!pendingCommits.has(sel)) pendingCommits.set(sel, new Map());
    pendingCommits.get(sel).set(property, { value, useVariables });

    clearTimeout(commitTimer);
    commitTimer = setTimeout(flushCommits, COMMIT_DELAY);
}

/** Немедленно дописать всё, что висит в очереди */
function flushCommits() {
    clearTimeout(commitTimer);
    commitTimer = null;
    if (!pendingCommits.size) return;

    const queue = new Map(pendingCommits);
    pendingCommits.clear();

    let next = customCSS;
    let lastSel = null;
    let lastProp = null;

    for (const [sel, decls] of queue) {
        for (const [property, entry] of decls) {
            next = generator.updateRule(next, sel, property, entry.value, {
                useVariables: entry.useVariables,
                editInPlace: cfg().editInPlace,
            });
            lastSel = sel;
            lastProp = property;
        }
    }

    if (next === customCSS) return;

    pushHistory(next);
    writeCSS(next);
    if (lastSel) revealInEditor(lastSel, lastProp);
}

/** Выбросить очередь без записи — нужно для undo/redo и правки кода вручную */
function dropPendingCommits() {
    clearTimeout(commitTimer);
    commitTimer = null;
    pendingCommits.clear();
}

/** Прокручивает панель кода к тому месту, куда только что записали */
function revealInEditor(sel, property) {
    if (!cfg().followCode) return;
    if (!editor?.isOpen?.()) return;

    clearTimeout(revealTimer);
    revealTimer = setTimeout(() => {
        let idx;
        try { idx = rules.buildIndex(customCSS); } catch { return; }

        const key = String(sel).replace(/\s+/g, ' ').trim();
        let hit = null;
        for (const rule of idx.rules) {
            if (rule.parts.some(p => p.raw.replace(/\s+/g, ' ') === key)) hit = rule;
        }
        if (!hit) return;

        let from = hit.ruleStart;
        let to = hit.ruleEnd;
        if (property) {
            const d = rules.findDeclaration(hit, property);
            if (d) { from = d.start; to = d.end; }
        }
        editor.revealRange(from, to, { focus: false });
    }, 140);
}

function handlePropertyChange(sel, property, value, opts = {}) {
    if (property === '__reset__') {
        dropPendingCommits();
        const next = generator.updateRule(customCSS, sel, '__reset__', '');
        dropPreviewFor(sel);
        pushHistory(next);
        writeCSS(next);
        toast('Правила для цели убраны');
        return;
    }

    previewProperty(sel, property, value);

    // Ползунок ещё тянут: показываем предпросмотр, но CSS не переписываем.
    // Раньше этот флаг игнорировался, и каждое движение мыши создавало
    // шаг истории и запись в CSS.
    if (opts.live) return;

    // Переменная темы живёт в :root и действует на весь интерфейс.
    // Для псевдоэлемента это почти всегда не то, что человек хотел:
    // менял одну иконку, а поехали все. Пишем обычное правило.
    const isPseudo = String(sel).includes('::');
    const useVariables = isPseudo
        ? false
        : (opts.useVariables ?? cfg().useVariables);

    queueCommit(sel, property, value, useVariables);
}

/** Пишет сразу несколько свойств. Несколько вызовов подряд склеиваются в один шаг истории */
function handleBatchChange(sel, decls) {
    for (const [prop, value] of Object.entries(decls)) {
        queueCommit(sel, prop, value === '' ? '' : value, false);
    }
    // Нулевая задержка: все writeDecls внутри одного «Применить» выполняются
    // подряд, поэтому успевают попасть в одну очередь и один шаг истории.
    clearTimeout(commitTimer);
    commitTimer = setTimeout(() => {
        flushCommits();
        dropPreviewFor(sel);
    }, 0);
}


function handleVarInfoRequest(sel, property, opts = {}) {
    const wantVars = opts.useVariables ?? cfg().useVariables;

    if (wantVars) {
        try {
            const v = generator.findVariable(sel, property);
            if (v?.name) return { mode: 'variable', name: v.name };
        } catch {}
    }

    if (cfg().editInPlace) {
        try {
            const spot = generator.findEditSpot(customCSS, sel, property);
            if (spot) {
                return {
                    mode: 'in-place',
                    line: spot.line,
                    selector: spot.selector,
                    hasProperty: spot.hasProperty,
                };
            }
        } catch {}
    }

    return { mode: 'auto' };
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
    // Человек правит код руками — это источник истины,
    // отложенные правки ползунков выбрасываем
    dropPendingCommits();

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

    if (!document.getElementById('vte-wand-tpl')) {
        menu.appendChild(h('div#vte-wand-tpl.list-group-item.flex-container.flexGap5.interactable', {
            tabIndex: 0,
            on: { click: toggleTemplates },
        }, [
            h('div.fa-solid.fa-layer-group.extensionsMenuExtensionButton'),
            h('span', { text: 'Шаблоны групп элементов' }),
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
        check('editInPlace', 'Править код темы на месте (экспериментально)',
            'Если правило для элемента уже есть в вашем CSS, значение меняется прямо в нём. '
            + 'Правила со списком селекторов через запятую по-прежнему идут в авто-блок'),
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

    const tplBtn = h('button.menu_button', {
        type: 'button',
        title: 'Собрать группу однотипных элементов и править их вместе',
        on: { click: toggleTemplates },
    }, [icon('fa-layer-group'), h('span', { text: ' Шаблоны групп' })]);

    const cleanBtn = h('button.menu_button', {
        type: 'button',
        on: { click: removeAutoBlock },
    }, [icon('fa-broom'), h('span', { text: ' Убрать авто-блок' })]);

    const exportBtn = h('button.menu_button', {
        type: 'button',
        on: { click: exportCSS },
    }, [icon('fa-download'), h('span', { text: ' Скачать CSS' })]);

    const toolsRow = h('div.vte-settings-actions', {}, [codeBtn, tplBtn, cleanBtn, exportBtn]);

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

        if (active) {
            // Редактор открыт — это просто ещё один шаг, а не новая тема.
            // Раньше здесь история обнулялась, и отменять становилось нечего.
            if (history[history.length - 1] !== css) {
                history.push(css);
                if (history.length > HISTORY_LIMIT) history.shift();
            }
        } else {
            history = [css];
            future = [];
        }

        updateHistoryButtons();
        if (editor?.isOpen?.()) editor.setContent(css, { silent: true });
    };

    [et.SETTINGS_UPDATED, et.SETTINGS_LOADED, et.APP_READY].forEach(name => {
        if (name) { try { ev.on(name, () => setTimeout(resync, 300)); } catch {} }
    });
}

function handleTextApply(ruleset, opts = {}) {
    if (!ruleset?.length) return;

    for (const { selector, decls } of ruleset) {
        for (const [prop, value] of Object.entries(decls)) {
            queueCommit(selector, prop, value === '' ? 'unset' : value, false);
        }
    }

    flushCommits();
    clearPreviewStyles();
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
            // Во время набора шаблона прицел гаснет по кнопке «Готово»,
            // сообщать об этом отдельно не нужно
            if (!on && active && !templates.isCollecting()) {
                toast('Выбор элемента выключен');
            }
        },
        highlightColor: cfg().highlightColor,
    });

    inspector.init({
        onPropertyChange: handlePropertyChange,
        onBatchChange: handleBatchChange,
        onTextApply: handleTextApply,
        onDone: () => flushCommits(),
        onRequestVarInfo: handleVarInfoRequest,
        onFontsTabMount: (el) => fonts.mount(el),
        onPickAgain: () => startPicking(),
        onOpenTemplates: () => toggleTemplates(),
        onUndo: undo,
        onRedo: redo,
        picker,
    });

    templates.init({
        store: cfg(),
        persist,
        onRequestPick: () => startPicking(),
        onStopPick: () => stopPicking(),
        onEditTemplate: editTemplateGroup,
        onSelectorFor: (el) => generator.generateSelector(el),
        onToast: (text) => toast(text),
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
        inspect: inspectElement,
        getCSS: readCSS,
        setCSS: (css) => { pushHistory(css); writeCSS(css); },
        undo,
        redo,
        variables: () => { generator.parse(readCSS()); return generator.getVariables(); },
        selectorFor: (el) => generator.generateSelector(el),
        targetsFor: (el) => buildTargets(el),
        ruleIndex: () => getRuleIndex(),
        templates: {
            panel: () => templates.togglePanel(),
            list: () => cfg().templates,
            active: () => templates.getActive(),
            selector: () => templates.activeSelector(),
            edit: (id) => {
                const t = templates.setActive(id);
                if (t) editTemplateGroup(t.items.map(i => i.selector).join(', '), t);
            },
        },
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
