/**
 * 弹窗顺手 + 密钥小眼睛 (Popup Polish)
 * ------------------------------------------------------------------
 * SillyTavern / TauriTavern 通用扩展，两件事：
 *
 * 1) API 密钥框右边加一个「小眼睛」
 *    原生 `#api_key_*` 是 type="text"，但客户端存完密钥就把框清空，所以平时框里是空的。
 *    点眼睛：框里有字 → 直接明文；框里是空的 → 向后端 /api/secrets/find 要已存的密钥填回框里。
 *    我们填进去的明文在点别的按钮之前会自己抹掉，免得客户端把同一把密钥又存一遍。
 *
 * 2) 输入类弹窗（新增 / 改名 API 连接配置、各种「起个名字」弹窗）优化
 *    - 输入框更宽更高，名字超长时**保持一行**往右延伸（原生是 textarea 会换行）
 *    - 输入法弹出遮住名字时，把弹窗往上推（可以推出屏幕顶部）直到名字露出来
 *    - 推上去之后可以用手指把弹窗**拉回来看**，拉的过程不关输入法；推 / 拉都有边界
 *    - 点空白处仍然是原生行为（收输入法），输入法一收弹窗自动回位
 *    - 原生开窗动画是 `scaleY(0) → scaleY(1)` + 背景实时高斯模糊，手机上必卡；
 *      换成短促的位移 + 淡入，并且开窗过程中不做模糊
 *
 * 全部改动只作用在弹窗和密钥框上，可以在「扩展」面板里逐项关掉。
 */

const MODULE_NAME = 'tavernPopupPolish';
const LOG = '[popup-polish]';

const DEFAULT_SETTINGS = {
    enabled: true,

    /* 密钥小眼睛 */
    keyReveal: true,        // 密钥框右边加小眼睛
    guardKeyHint: true,     // 不让已存的密钥出现在输入框的提示文字(placeholder)里

    /* 弹窗输入框外观 */
    widePopup: true,        // 输入类弹窗整体更宽
    popupWidth: 640,        // 目标宽度(px)，窄屏自动收到 100dvw-12px
    roomyInput: true,       // 输入框更高（原生 rows=1 太扁）
    inputHeight: 42,        // 输入框最小高度(px)
    singleLine: true,       // 名字超长时保持一行往右延伸，不换行

    /* 输入法避让 */
    kbdAvoid: true,         // 输入法遮住输入框时把弹窗往上推
    kbdMargin: 10,          // 输入框底部与输入法之间留的空(px)
    kbdMinInset: 90,        // 视口底部被吃掉超过这个值才算「输入法开了」(px)
    dragShift: true,        // 可以用手指上下拖动弹窗
    dragAlways: false,      // 输入法没开时也允许拖动
    dragOverflow: true,     // 弹窗比屏幕高（顶部被切掉）时也允许拖着看
    freezeHeight: true,     // 输入法弹出时不让弹窗跟着 dvh 变高变矮（防抖）

    /* 动画 */
    smoothAnim: true,       // 换掉原生 scaleY 开窗动画
    animMs: 150,            // 开窗动画时长(ms)
    cheapBackdrop: true,    // 弹窗背景不做高斯模糊（只保留压暗）
    deferFocus: false,      // 等开窗动画结束再聚焦输入框（输入法晚一点弹，更不卡；某些环境可能不自动弹输入法）

    debug: false,
};

const TXT = {
    showKey: ['显示密钥明文', 'Show the key'],
    hideKey: ['隐藏密钥', 'Hide the key'],
    keySaved: ['密钥已保存', 'Key saved'],
    keyExposureOff: [
        '客户端不让看密钥明文：去设置里打开「允许密钥暴露 / Allow Keys Exposure」再重启',
        'Key exposure is disabled — enable "Allow Keys Exposure" in settings and restart',
    ],
    keyEmpty: ['这个来源还没存过密钥', 'No key stored for this source yet'],
    keyReadFailed: ['没能读到已存的密钥', 'Could not read the stored key'],
    title: ['弹窗顺手 + 密钥小眼睛', 'Popup Polish'],
};

/* ------------------------------------------------------------------ utils */

function ctx() {
    try {
        return globalThis.SillyTavern?.getContext?.() ?? null;
    } catch {
        return null;
    }
}

function cfg() {
    const store = ctx()?.extensionSettings;
    if (!store) {
        globalThis.__tppFallbackCfg ??= { ...DEFAULT_SETTINGS };
        return globalThis.__tppFallbackCfg;
    }
    if (!store[MODULE_NAME]) store[MODULE_NAME] = {};
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        if (store[MODULE_NAME][k] === undefined) store[MODULE_NAME][k] = v;
    }
    return store[MODULE_NAME];
}

function saveCfg() {
    try {
        ctx()?.saveSettingsDebounced?.();
    } catch { /* ignore */ }
}

function isZh() {
    const lang = ctx()?.getCurrentLocale?.() || document.documentElement.lang || navigator.language || '';
    return /^zh/i.test(String(lang));
}

function t(key) {
    const pair = TXT[key] || ['', ''];
    return isZh() ? pair[0] : pair[1];
}

function dbg(...args) {
    if (cfg().debug) console.log(LOG, ...args);
}

function warn(...args) {
    console.warn(LOG, ...args);
}

function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
}

function toast(kind, message) {
    try {
        globalThis.toastr?.[kind]?.(message);
    } catch {
        console.log(LOG, message);
    }
}

/** 把一个数字型 CSS 变量读成 px 数 */
function cssPx(name) {
    try {
        const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        if (!raw) return 0;
        const n = parseFloat(raw);
        return Number.isFinite(n) ? n : 0;
    } catch {
        return 0;
    }
}

/* ------------------------------------------------- 视口 / 输入法高度 */

function isMobileUA() {
    return /Android|iPhone|iPad|iPod|Mobile|Tauri/i.test(navigator.userAgent || '');
}

/** 布局视口高度（`__tppLayoutH` 是测试覆盖用的） */
function layoutHeight() {
    const test = Number(globalThis.__tppLayoutH);
    if (Number.isFinite(test) && test > 0) return test;
    return document.documentElement.clientHeight || window.innerHeight || 0;
}

/**
 * 手机上「输入法没弹出时」的视口高度。
 * 安卓 WebView 如果跑在 adjustResize 模式（TauriTavern 常见），输入法弹出会把
 * **布局视口**整个缩小 —— 这时 visualViewport 和布局视口一样高，inset 恒等于 0，
 * 光看 inset 根本看不出输入法开着。所以额外记住历史最大高度当基线。
 */
let baseLayoutH = 0;

function noteLayoutHeight() {
    const h = layoutHeight();
    if (h > baseLayoutH) baseLayoutH = h;
    return h;
}

/**
 * 可见区域（去掉输入法占的那一块）。四路信号取最保守的那个：
 *   - visualViewport：手机浏览器（Chrome / Termux 里的酒馆）输入法弹出只缩它
 *   - --tt-ime-bottom：TauriTavern 的 Android 原生层直接注入的输入法高度
 *   - 布局视口本身缩小：WebView 的 adjustResize 模式
 *   - globalThis.__tppKbdInset：测试用的手动覆盖
 */
function viewport() {
    const layoutH = noteLayoutHeight();
    const vv = window.visualViewport;
    const top = vv ? vv.offsetTop : 0;
    let bottom = vv ? vv.offsetTop + vv.height : layoutH;

    // adjustResize 下布局视口已经不含输入法，可见区不可能超过它
    bottom = Math.min(bottom, layoutH);

    const ime = cssPx('--tt-ime-bottom');
    if (ime > 0) bottom = Math.min(bottom, layoutH - ime);

    const test = Number(globalThis.__tppKbdInset);
    if (Number.isFinite(test) && test > 0) bottom = Math.min(bottom, layoutH - test);

    return { top, bottom, layoutH, inset: Math.max(0, layoutH - bottom) };
}

function keyboardOpen(vp = viewport()) {
    if (vp.inset >= cfg().kbdMinInset) return true;
    // adjustResize：视口自己缩了，inset 看不出来 —— 只在手机上启用这一路，
    // 免得桌面用户拖动窗口高度时被误判成输入法。
    if (isMobileUA() && baseLayoutH - vp.layoutH >= cfg().kbdMinInset && isEditable(document.activeElement)) {
        return true;
    }
    return false;
}

/* ------------------------------------------------------- 弹窗增强 */

/** 当前被我们接管的弹窗 → 状态 */
const popups = new Map();

function isEditable(el) {
    if (!(el instanceof HTMLElement)) return false;
    if (el.isContentEditable) return true;
    if (el instanceof HTMLTextAreaElement) return true;
    if (el instanceof HTMLInputElement) {
        return !['checkbox', 'radio', 'button', 'submit', 'range', 'color', 'file'].includes(el.type);
    }
    return false;
}

/** 这个弹窗是不是「让人输入点东西」的弹窗 */
function mainInputOf(dlg) {
    const input = dlg.querySelector('.popup-input');
    if (!input) return null;
    if (input.style.display === 'none') return null;      // 非 INPUT 型弹窗，客户端会显式藏起来
    if (!input.offsetParent && !dlg.hasAttribute('open')) return null;
    return input;
}

/** 输入法要避让的目标：弹窗里当前聚焦的输入控件，没有就用主输入框 */
function shiftTarget(dlg) {
    const state = popups.get(dlg);
    const active = document.activeElement;
    if (active && dlg.contains(active) && isEditable(active)) return active;
    return state?.input || mainInputOf(dlg);
}

function currentShift(dlg) {
    return parseFloat(dlg.style.getPropertyValue('--tpp-shift')) || 0;
}

/**
 * 弹窗**这一刻**实际的纵向位移（从 computed transform 矩阵里读）。
 * 不能用 --tpp-shift 当基线：过渡 / 开窗动画进行中它是「目标值」，
 * 而 getBoundingClientRect() 给的是插值后的位置，两者相减会算出偏移量，
 * 于是每次重算都往上多推一截。
 */
function actualShift(dlg) {
    try {
        const raw = getComputedStyle(dlg).transform;
        if (!raw || raw === 'none') return 0;
        const nums = raw.slice(raw.indexOf('(') + 1, -1).split(',').map(Number);
        if (raw.startsWith('matrix3d')) return nums[13] || 0;
        return nums[5] || 0;
    } catch {
        return currentShift(dlg);
    }
}

function setShift(dlg, px) {
    dlg.style.setProperty('--tpp-shift', `${Math.round(px)}px`);
}

/**
 * 位移的允许范围（推 / 拉都不许过头）。
 *   min（负 = 往上）：再往上推，输入框顶部就要出屏幕了
 *   max（≥0 = 往下）：手机上弹窗常常比屏幕还高、顶部被截掉一截，
 *                     截掉多少就允许往下拉回多少（拉到能看见标题为止），
 *                     弹窗没被截断时 max = 0，也就是「最多回到原位」
 */
function bounds(dlg) {
    const vp = viewport();
    const shift = actualShift(dlg);
    const dr = dlg.getBoundingClientRect();
    const baseDlgTop = dr.top - shift;
    const baseDlgBottom = dr.bottom - shift;

    const target = shiftTarget(dlg);
    let min;
    if (target) {
        const r = target.getBoundingClientRect();
        min = -Math.max(0, (r.top - shift) - vp.top - 8);
    } else {
        // 没有输入框的弹窗：往上最多推到底边贴着可见区底部
        min = -Math.max(0, baseDlgBottom - vp.bottom);
    }

    const clipped = Math.max(0, vp.top - baseDlgTop);
    return { min, max: cfg().dragOverflow ? clipped : 0, vp, shift, clipped };
}

/**
 * 算这个弹窗现在该往上推多少。
 * shift 为负数表示往上推；自动避让只会在 [min, 0] 里选，永远不会自己往下拉。
 */
function measure(dlg) {
    const target = shiftTarget(dlg);
    if (!target) return null;

    const b = bounds(dlg);
    const rect = target.getBoundingClientRect();
    const baseBottom = rect.bottom - b.shift;
    // 需要推多少：输入框底部 + 留白 要落在输入法上沿以上
    const need = -(baseBottom + cfg().kbdMargin - b.vp.bottom);

    return { shift: clamp(Math.min(0, need), b.min, 0), min: b.min, max: b.max, need, vp: b.vp };
}

function applyAutoShift(dlg, { force = false } = {}) {
    const state = popups.get(dlg);
    if (!state || !cfg().kbdAvoid) return;
    if (!dlg.hasAttribute('open') || dlg.hasAttribute('closing')) return;

    const vp = viewport();

    // 输入法收了 → 回位，同时解除「用户手动拖过」的锁定，并重新记一次视口高度
    if (!keyboardOpen(vp)) {
        state.kbdWasOpen = false;
        if (cfg().freezeHeight) freezeHeight(dlg);
        // 例外：没有输入法的时候用户自己拖着看被截断的内容，别把他拽回去
        if (state.manualNoKbd) return;
        state.manual = false;
        if (currentShift(dlg) !== 0) setShift(dlg, 0);
        return;
    }

    // 输入法「重新弹出」算新的一轮 —— 手动拖过的锁只在同一轮里有效。
    // （安卓用返回键收输入法不会让输入框失焦，所以不能只靠 focusin 解锁）
    if (!state.kbdWasOpen) {
        state.kbdWasOpen = true;
        state.manual = false;
        state.manualNoKbd = false;
    }

    if (state.manual && !force) return;      // 这一轮里用户自己拉过，别跟他抢

    const m = measure(dlg);
    if (!m) return;
    if (Math.abs(m.shift - currentShift(dlg)) < 1) return;
    setShift(dlg, m.shift);
    dbg('auto shift', m.shift, 'need', m.need, 'min', m.min);
}

/** 把弹窗的最大高度钉在「输入法没开时」的视口高度上，输入法弹出时弹窗就不会变形抖动 */
function freezeHeight(dlg) {
    const h = layoutHeight();
    // adjustResize 的 WebView 在输入法弹出时布局视口是缩小的，别把缩小后的高度钉进去
    const use = Math.max(h, baseLayoutH);
    if (use > 0) dlg.style.setProperty('--tpp-vh', `${use}px`);
}

/* ------------------------------------------------------- 手指拖动 */

/** 手机上弹窗常比屏幕高，顶部被切掉一截 —— 这种情况也该能拖着看 */
function overflowsViewport(dlg) {
    if (!cfg().dragOverflow) return false;
    return bounds(dlg).clipped > 4;
}

function dragEnabled(dlg) {
    const c = cfg();
    if (!c.enabled || !c.dragShift) return false;
    return c.dragAlways || keyboardOpen() || currentShift(dlg) !== 0 || overflowsViewport(dlg);
}

/** 从这个元素上开始滑动算不算「拖弹窗」 */
function dragAllowedFrom(dlg, target) {
    if (!(target instanceof Element)) return true;
    if (target.closest('.popup-controls, .popup-button-close, button, select, option, a')) return false;
    if (isEditable(target)) return false;                 // 输入框里滑动是选字，不抢
    // 自己能滚的容器交给它自己滚
    for (let el = target; el && el !== dlg; el = el.parentElement) {
        const style = getComputedStyle(el);
        const scrolls = /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 2;
        if (scrolls) return false;
    }
    return true;
}

function bindDrag(dlg, state) {
    const begin = (y, target) => {
        if (!dragAllowedFrom(dlg, target)) {
            state.drag = null;
            return;
        }
        // start 用「这一刻实际位移」，半路截住正在滑动的弹窗也不会跳
        state.drag = { y0: y, start: actualShift(dlg), active: false, min: 0, max: 0 };
    };

    const move = (y, prevent) => {
        const d = state.drag;
        if (!d) return;
        const dy = y - d.y0;
        if (!d.active) {
            if (Math.abs(dy) < 8) return;                 // 阈值内当点击处理（点空白 → 原生收输入法）
            if (!dragEnabled(dlg)) {
                state.drag = null;
                return;
            }
            d.active = true;
            const b = bounds(dlg);
            d.min = b.min;
            d.max = b.max;
            state.manual = true;                          // 之后不再自动推，听用户的
            // 没输入法时拖 = 在看被截断的内容，别在轮询里把他拽回原位
            state.manualNoKbd = !keyboardOpen();
            dlg.classList.add('tpp-dragging');
        }
        // 关键：把这一串触摸的默认行为取消掉 —— 连带取消 click 与焦点变化，
        // 所以拉弹窗的时候输入法不会被收起来。
        prevent?.();
        setShift(dlg, clamp(d.start + dy, d.min, d.max));
    };

    const end = () => {
        if (state.drag?.active) dlg.classList.remove('tpp-dragging');
        state.drag = null;
    };

    const onTouchStart = (e) => {
        if (e.touches.length !== 1) return end();
        begin(e.touches[0].clientY, e.target);
    };
    const onTouchMove = (e) => {
        if (e.touches.length !== 1) return;
        move(e.touches[0].clientY, () => { if (e.cancelable) e.preventDefault(); });
    };
    const onPointerDown = (e) => {
        if (e.pointerType === 'touch') return;            // 触摸走 touch 事件（那边才能拦住焦点变化）
        if (e.button !== 0) return;
        begin(e.clientY, e.target);
    };
    const onPointerMove = (e) => {
        if (e.pointerType === 'touch') return;
        move(e.clientY, () => { if (e.cancelable) e.preventDefault(); });
    };

    dlg.addEventListener('touchstart', onTouchStart, { passive: true });
    dlg.addEventListener('touchmove', onTouchMove, { passive: false });
    dlg.addEventListener('touchend', end, { passive: true });
    dlg.addEventListener('touchcancel', end, { passive: true });
    dlg.addEventListener('pointerdown', onPointerDown);
    dlg.addEventListener('pointermove', onPointerMove);
    dlg.addEventListener('pointerup', end);
    dlg.addEventListener('pointercancel', end);
}

/* --------------------------------------------------- 装配 / 卸载弹窗 */

let rafToken = 0;

function schedule() {
    if (rafToken) return;
    rafToken = requestAnimationFrame(() => {
        rafToken = 0;
        for (const dlg of [...popups.keys()]) {
            if (!document.contains(dlg)) {
                forget(dlg);
                continue;
            }
            applyAutoShift(dlg);
        }
    });
}

function forget(dlg) {
    popups.delete(dlg);
}

/** 等开窗动画结束（拿不到动画就退化成定时器） */
function afterOpen(dlg, callback) {
    let done = false;
    const run = () => {
        if (done) return;
        done = true;
        try {
            callback();
        } catch (error) {
            warn('afterOpen failed', error);
        }
    };
    dlg.addEventListener('animationend', run, { once: true });
    setTimeout(run, (cfg().animMs || 150) + 120);
}

function enhance(dlg) {
    if (!cfg().enabled || popups.has(dlg)) return;
    const c = cfg();
    const input = mainInputOf(dlg);
    const state = { input, manual: false, manualNoKbd: false, kbdWasOpen: false, drag: null };
    popups.set(dlg, state);

    dlg.classList.add('tpp-popup');
    setShift(dlg, 0);

    if (c.smoothAnim) {
        dlg.classList.add('tpp-anim');
        dlg.style.setProperty('--tpp-anim-ms', `${c.animMs}ms`);
    }
    if (c.cheapBackdrop) dlg.classList.add('tpp-cheap-backdrop');
    if (c.freezeHeight) {
        dlg.classList.add('tpp-freeze');
        freezeHeight(dlg);
    }

    if (input) {
        dlg.classList.add('tpp-input-popup');
        if (c.widePopup) {
            dlg.classList.add('tpp-wide');
            dlg.style.setProperty('--tpp-width', `${c.popupWidth}px`);
        }
        if (c.roomyInput) {
            dlg.classList.add('tpp-roomy');
            dlg.style.setProperty('--tpp-input-height', `${c.inputHeight}px`);
        }
        if (c.singleLine && (Number(input.rows) || 1) <= 1) {
            input.classList.add('tpp-oneline');
            input.setAttribute('wrap', 'off');
        }
    }

    bindDrag(dlg, state);

    // 用户点进弹窗里另一个输入框 → 重新按那个框避让
    dlg.addEventListener('focusin', () => {
        // 用户主动点进某个输入框 = 重新表达意图，恢复自动避让
        state.manual = false;
        state.manualNoKbd = false;
        schedule();
    });
    dlg.addEventListener('input', schedule);

    dbg('enhanced', { input: !!input, classes: dlg.className });
    schedule();
    afterOpen(dlg, () => schedule());
}

/**
 * 最早的钩子：`showModal()` 之前。
 * 这里装配可以避免弹窗先以原生样子闪一帧，也是唯一能在浏览器处理 autofocus
 * 之前把 autofocus 摘掉的时机（deferFocus）。
 */
function patchShowModal() {
    const proto = globalThis.HTMLDialogElement?.prototype;
    if (!proto || proto.__tppPatched) return;
    const original = proto.showModal;
    proto.showModal = function (...args) {
        let deferred = null;
        try {
            if (this.classList?.contains('popup') && cfg().enabled) {
                enhance(this);
                if (cfg().deferFocus && mainInputOf(this)) {
                    const auto = this.querySelector('[autofocus]');
                    if (auto) {
                        auto.removeAttribute('autofocus');
                        deferred = auto;
                    }
                }
            }
        } catch (error) {
            warn('pre-show hook failed', error);
        }
        const result = original.apply(this, args);
        if (deferred) {
            afterOpen(this, () => {
                deferred.setAttribute('autofocus', '');
                try {
                    deferred.focus();
                } catch { /* ignore */ }
            });
        }
        return result;
    };
    proto.__tppPatched = true;
}

/** 兜底：有些环境走 dialog polyfill，不经过 showModal */
function watchPopups() {
    const observer = new MutationObserver((records) => {
        for (const record of records) {
            for (const node of record.addedNodes) {
                if (node instanceof HTMLElement && node.matches?.('dialog.popup')) enhance(node);
            }
            for (const node of record.removedNodes) {
                if (node instanceof HTMLElement && popups.has(node)) forget(node);
            }
        }
    });
    observer.observe(document.body, { childList: true });
}

function bindViewport() {
    const vv = window.visualViewport;
    vv?.addEventListener('resize', schedule);
    vv?.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule);
    window.addEventListener('orientationchange', schedule);
    document.addEventListener('focusin', schedule);
    document.addEventListener('focusout', schedule);
    // 测试 / 兜底钩子：有的 WebView 不发 visualViewport 事件
    document.addEventListener('tpp-viewport', schedule);
    setInterval(() => {
        if (popups.size) schedule();
    }, 250);
}

/* ------------------------------------------------------- 密钥小眼睛 */

/** 密钥输入框 → { eye, injected, origType, origPlaceholder, obs } */
const eyes = new Map();

/** 「已保存的密钥被写进提示文字」的特征：客户端写的是 `<Key saved> (sk-xxxx)` */
const KEY_HINT_RE = /(<?\s*key\s*saved|密钥已保存|已保存)/i;

function looksLikeKeyHint(value) {
    if (!value) return false;
    return KEY_HINT_RE.test(value) || /[A-Za-z0-9_-]{16,}/.test(value);
}

function keyInputs() {
    return [...document.querySelectorAll('input[id^="api_key_"], input#custom_api_key')];
}

function setEyeState(rec, revealed) {
    if (!rec?.eye) return;
    rec.eye.classList.toggle('fa-eye', !revealed);
    rec.eye.classList.toggle('fa-eye-slash', revealed);
    rec.eye.title = revealed ? t('hideKey') : t('showKey');
}

function mask(input) {
    if (input.type !== 'password') input.type = 'password';
}

/**
 * 向后端要已存的密钥明文。
 * 走的是跟原生「查看隐藏的 API 密钥」同一个开关，没开会回 403。
 */
async function fetchStoredKey(keyName) {
    if (!keyName) return { ok: false, status: 0 };
    const headers = ctx()?.getRequestHeaders?.() || { 'Content-Type': 'application/json' };
    try {
        const res = await fetch('/api/secrets/find', {
            method: 'POST',
            headers,
            body: JSON.stringify({ key: keyName }),
        });
        if (!res.ok) return { ok: false, status: res.status };
        const data = await res.json();
        return { ok: true, value: typeof data?.value === 'string' ? data.value : '' };
    } catch (error) {
        warn('read secret failed', error);
        return { ok: false, status: 0 };
    }
}

async function toggleReveal(input) {
    const rec = eyes.get(input);
    if (!rec) return;

    // 当前是明文 → 收起来（我们填进去的明文顺手抹掉）
    if (input.type !== 'password') {
        if (rec.injected) {
            input.value = '';
            rec.injected = false;
        }
        mask(input);
        setEyeState(rec, false);
        return;
    }

    if (!input.value) {
        const res = await fetchStoredKey(input.id);
        if (!res.ok) {
            toast('warning', res.status === 403 ? t('keyExposureOff') : t('keyReadFailed'));
            return;
        }
        if (!res.value) {
            toast('info', t('keyEmpty'));
            return;
        }
        input.value = res.value;
        rec.injected = true;
    }
    input.type = 'text';
    setEyeState(rec, true);
}

/** 把我们填进去的明文抹掉：留着的话点「连接 / 加载模型」会让客户端把同一把密钥又存一遍 */
function clearInjected(input, rec) {
    if (!rec.injected) return;
    rec.injected = false;
    input.value = '';
    mask(input);
    setEyeState(rec, false);
    dbg('cleared injected key', input.id);
}

function guardPlaceholder(input, rec) {
    const enforce = () => {
        if (!cfg().enabled || !cfg().guardKeyHint) return;
        const value = input.getAttribute('placeholder') || '';
        if (!value || value === t('keySaved')) return;
        if (value === rec.origPlaceholder) return;
        if (!looksLikeKeyHint(value)) return;
        rec.nativeHint = value;
        input.setAttribute('placeholder', t('keySaved'));
    };
    const obs = new MutationObserver(enforce);
    obs.observe(input, { attributes: true, attributeFilter: ['placeholder'] });
    rec.obs = obs;
    enforce();
}

function attachEye(input) {
    const rec = {
        origType: input.getAttribute('type'),
        origPlaceholder: input.getAttribute('placeholder') || '',
        injected: false,
    };

    const eye = document.createElement('div');
    eye.className = 'menu_button fa-solid fa-eye tpp-eye';
    eye.title = t('showKey');
    eye.tabIndex = 0;
    eye.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleReveal(input);
    });
    input.insertAdjacentElement('afterend', eye);
    rec.eye = eye;
    eyes.set(input, rec);

    // 原生密钥框是 type="text"（明文直接可见），先遮成圆点，点眼睛才看
    mask(input);
    const style = getComputedStyle(input);
    eye.style.marginTop = style.marginTop;
    eye.style.marginBottom = style.marginBottom;

    input.addEventListener('input', () => { rec.injected = false; });
    guardPlaceholder(input, rec);
    dbg('eye attached', input.id);
}

/** 别人（比如 api-panel-layout）已经在这一行放过眼睛了，就不再放第二只 */
function foreignEye(input) {
    const row = input.parentElement;
    if (!row) return false;
    return [...row.children].some(el => el !== input
        && !el.classList.contains('tpp-eye')
        && (el.classList.contains('fa-eye') || el.classList.contains('fa-eye-slash') || el.classList.contains('ttal-eye')));
}

function ensureEyes() {
    if (!cfg().enabled || !cfg().keyReveal) return;
    for (const input of keyInputs()) {
        if (!eyes.has(input) && foreignEye(input)) continue;
        if (eyes.has(input)) {
            if (!document.contains(eyes.get(input).eye)) {
                // 客户端重建了这一行，把眼睛放回去
                input.insertAdjacentElement('afterend', eyes.get(input).eye);
            }
            continue;
        }
        try {
            attachEye(input);
        } catch (error) {
            warn('attach eye failed', input.id, error);
        }
    }
}

/** 关掉「小眼睛」时把密钥框还原成原生样子 */
function removeEyes() {
    for (const [input, rec] of eyes) {
        try {
            if (rec.injected) input.value = '';
            rec.obs?.disconnect();
            if (rec.nativeHint && (input.getAttribute('placeholder') || '') === t('keySaved')) {
                input.setAttribute('placeholder', rec.nativeHint);
            }
            if (rec.origType) input.setAttribute('type', rec.origType);
            else input.removeAttribute('type');
            rec.eye?.remove();
        } catch (error) {
            warn('remove eye failed', error);
        }
    }
    eyes.clear();
}

function bindKeyGuards() {
    // 点「连接 / 加载模型」等任何按钮之前，先把我们填的明文抹掉。
    // 必须挂在 document 的捕获阶段：客户端的处理器绑得比我们早，同一元素上先跑它。
    document.addEventListener('click', (event) => {
        if (!eyes.size) return;
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (target.closest('.tpp-eye')) return;
        const isControl = target.closest('button, .menu_button, select, option, [id^="api_button"], .fa-solid');
        if (!isControl) return;
        for (const [input, rec] of eyes) {
            if (rec.injected && target !== input) clearInjected(input, rec);
        }
    }, true);

    document.addEventListener('change', (event) => {
        if (!eyes.size) return;
        if (event.target?.matches?.('#chat_completion_source, #main_api, #textgen_type')) {
            for (const [input, rec] of eyes) clearInjected(input, rec);
        }
    }, true);
}

/* --------------------------------------------------- 扩展设置面板 */

const TOGGLES = [
    ['enabled', '启用本扩展', 'Enable this extension'],
    ['keyReveal', '密钥框右边加「小眼睛」', 'Add an eye button next to the API key'],
    ['guardKeyHint', '不让已存的密钥出现在提示文字里', 'Keep the stored key out of the placeholder'],
    ['widePopup', '输入类弹窗更宽', 'Wider input popups'],
    ['roomyInput', '输入框更高（不那么扁）', 'Taller input field'],
    ['singleLine', '名字超长保持一行往右延伸', 'Keep the name on one line'],
    ['kbdAvoid', '输入法遮住时把弹窗往上推', 'Push the popup up when the keyboard covers it'],
    ['dragShift', '可以用手指上下拖动弹窗', 'Drag the popup up and down'],
    ['dragAlways', '输入法没开时也能拖', 'Allow dragging even without the keyboard'],
    ['dragOverflow', '弹窗比屏幕高时可以拖着看（手机）', 'Drag to peek when the popup is taller than the screen'],
    ['freezeHeight', '输入法弹出时不让弹窗变形', 'Freeze popup height while the keyboard is open'],
    ['smoothAnim', '换掉原生开窗动画（更顺）', 'Replace the native open animation'],
    ['cheapBackdrop', '弹窗背景不做高斯模糊（更顺）', 'No backdrop blur for popups'],
    ['deferFocus', '等动画结束再弹输入法（更顺，个别环境可能不自动弹）', 'Focus the input after the animation'],
    ['debug', '调试日志', 'Debug logging'],
];

const NUMBERS = [
    ['popupWidth', '弹窗目标宽度 (px)', 'Popup width (px)', 360, 1200],
    ['inputHeight', '输入框最小高度 (px)', 'Input height (px)', 24, 96],
    ['kbdMargin', '输入框与输入法的间距 (px)', 'Gap above the keyboard (px)', 0, 80],
    ['animMs', '开窗动画时长 (ms)', 'Animation duration (ms)', 60, 400],
];

function buildSettingsUI() {
    const host = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
    if (!host || document.querySelector('#tpp_settings')) return;

    const block = document.createElement('div');
    block.id = 'tpp_settings';
    block.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>${t('title')}</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content flex-container flexFlowColumn"></div>
        </div>`;
    const content = block.querySelector('.inline-drawer-content');

    for (const [key, zh, en] of TOGGLES) {
        const label = document.createElement('label');
        label.className = 'checkbox_label';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.id = `tpp_opt_${key}`;
        box.checked = !!cfg()[key];
        const span = document.createElement('span');
        span.textContent = isZh() ? zh : en;
        box.addEventListener('change', () => {
            cfg()[key] = box.checked;
            saveCfg();
            if (key === 'keyReveal' || key === 'enabled') {
                if (cfg().enabled && cfg().keyReveal) ensureEyes();
                else removeEyes();
            }
        });
        label.append(box, span);
        content.appendChild(label);
    }

    for (const [key, zh, en, min, max] of NUMBERS) {
        const row = document.createElement('div');
        row.className = 'flex-container alignItemsCenter tpp-setting-row';
        const span = document.createElement('span');
        span.textContent = isZh() ? zh : en;
        const field = document.createElement('input');
        field.type = 'number';
        field.className = 'text_pole';
        field.id = `tpp_num_${key}`;
        field.min = String(min);
        field.max = String(max);
        field.value = String(cfg()[key]);
        field.addEventListener('change', () => {
            const value = clamp(Number(field.value) || DEFAULT_SETTINGS[key], min, max);
            field.value = String(value);
            cfg()[key] = value;
            saveCfg();
        });
        row.append(span, field);
        content.appendChild(row);
    }

    const hint = document.createElement('small');
    hint.className = 'tpp-hint';
    hint.textContent = isZh()
        ? '弹窗相关的设置在下一次打开弹窗时生效。输入法把弹窗顶上去以后，在弹窗空白处上下滑动就能把它拉回来看，滑动不会收输入法；点一下空白处才收。'
        : 'Popup settings apply the next time a popup opens. Swipe on an empty area of the popup to pull it back; swiping keeps the keyboard open, a tap closes it.';
    content.appendChild(hint);

    host.appendChild(block);
}

/* --------------------------------------------------------- 初始化 */

function start() {
    try {
        patchShowModal();
        watchPopups();
        bindViewport();
        bindKeyGuards();
        ensureEyes();
        buildSettingsUI();
    } catch (error) {
        warn('start failed', error);
    }

    setInterval(() => {
        if (!document.querySelector('#tpp_settings')) {
            try {
                buildSettingsUI();
            } catch { /* ignore */ }
        }
        if (cfg().enabled && cfg().keyReveal) ensureEyes();
    }, 1500);

    console.log(LOG, 'ready');
}

globalThis.popupPolish = {
    cfg, saveCfg, viewport, keyboardOpen, measure, bounds, popups, eyes,
    enhance, ensureEyes, removeEyes, schedule, currentShift, setShift,
};

const jq = globalThis.jQuery || globalThis.$;
if (jq) jq(() => start());
else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
