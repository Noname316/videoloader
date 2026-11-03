// Firefox для e2e — целиком через Marionette (родной протокол автоматизации Firefox).
//
// Почему не puppeteer: через WebDriver BiDi страницы расширения (moz-extension://)
// не открыть, а вторую сессию рядом с BiDi Firefox не даёт. Marionette открывает
// вкладку расширения из привилегированного контекста (нужна переменная окружения
// MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1), дальше код выполняется в ней обычным
// WebDriver:ExecuteAsyncScript.
//
// launchFirefox() возвращает объект с той частью API браузера и страниц puppeteer,
// которой пользуется tests/e2e.mjs.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** Клиент Marionette: сообщения «длина:JSON», команды [0, id, имя, параметры]. */
class Marionette {
    static async connect(port, timeoutMs = 60000) {
        const started = Date.now();
        for (;;) {
            try {
                const sock = await new Promise((resolve, reject) => {
                    const s = net.connect(port, '127.0.0.1');
                    s.once('connect', () => resolve(s));
                    s.once('error', reject);
                });
                const m = new Marionette(sock);
                await m.ready;
                await m.cmd('WebDriver:NewSession', { capabilities: { pageLoadStrategy: 'normal' } });
                return m;
            } catch (e) {
                if (Date.now() - started > timeoutMs) throw new Error(`Marionette не отвечает на порту ${port}: ${e.message}`);
                await new Promise(r => setTimeout(r, 500));
            }
        }
    }

    constructor(sock) {
        this.sock = sock;
        this.buf = Buffer.alloc(0);
        this.nextId = 1;
        this.waiters = new Map();
        this.queue = Promise.resolve();
        this.ready = new Promise(resolve => { this.onGreeting = resolve; });
        sock.on('data', d => this.onData(d));
    }

    onData(chunk) {
        this.buf = Buffer.concat([this.buf, chunk]);
        for (;;) {
            const colon = this.buf.indexOf(0x3a);
            if (colon < 0) return;
            const len = Number(this.buf.subarray(0, colon).toString());
            if (this.buf.length < colon + 1 + len) return;
            const msg = JSON.parse(this.buf.subarray(colon + 1, colon + 1 + len).toString('utf8'));
            this.buf = this.buf.subarray(colon + 1 + len);
            if (!Array.isArray(msg)) {
                this.onGreeting(msg);
                continue;
            }
            const [, id, err, result] = msg;
            this.waiters.get(id)?.(err, result);
            this.waiters.delete(id);
        }
    }

    /** Одна команда без очереди. */
    raw(name, params = {}) {
        return new Promise((resolve, reject) => {
            const id = this.nextId++;
            this.waiters.set(id, (err, result) => (err ? reject(new Error(`${name}: ${err.message || JSON.stringify(err)}`)) : resolve(result)));
            const body = Buffer.from(JSON.stringify([0, id, name, params]));
            this.sock.write(Buffer.concat([Buffer.from(`${body.length}:`), body]));
        });
    }

    /**
     * Последовательность команд без чужих команд между ними: у Marionette одно
     * «текущее окно», а вкладок у теста несколько.
     * @template T
     * @param {(raw: (name: string, params?: object) => Promise<any>) => Promise<T>} fn
     * @returns {Promise<T>}
     */
    exclusive(fn) {
        const run = () => fn((name, params) => this.raw(name, params));
        const p = this.queue.then(run, run);
        this.queue = p.catch(() => {});
        return p;
    }

    cmd(name, params) {
        return this.exclusive(raw => raw(name, params));
    }
}

/** Исходник функции (функция или готовая строка). */
const source = fn => (typeof fn === 'function' ? String(fn) : fn);

/** Вкладка: подмножество API страницы puppeteer. */
class Page {
    constructor(m, handle) {
        this.m = m;
        this.handle = handle;
        this.currentUrl = '';
    }

    /** Команды в этой вкладке. */
    inTab(fn) {
        return this.m.exclusive(async raw => {
            await raw('WebDriver:SwitchToWindow', { handle: this.handle, focus: false });
            return fn(raw);
        });
    }

    async goto(url) {
        await this.inTab(raw => raw('WebDriver:Navigate', { url }));
        this.currentUrl = url;
    }

    url() {
        return this.currentUrl;
    }

    /**
     * Выполнить функцию в странице (асинхронную тоже) и вернуть результат.
     * Исходник вставляется в текст скрипта: eval внутри страниц расширения запрещён CSP.
     */
    async evaluate(fn, ...args) {
        const script = `const done = arguments[arguments.length - 1];
            Promise.resolve().then(() => (${source(fn)})(...Array.from(arguments).slice(0, -1)))
                .then(value => done({ value }), e => done({ error: String((e && e.message) || e) }));`;
        const result = await this.inTab(raw => raw('WebDriver:ExecuteAsyncScript', { script, args, scriptTimeout: 60000 }));
        const res = result?.value ?? {};
        if (res.error) throw new Error(res.error);
        return res.value;
    }

    $$eval(selector, fn, ...args) {
        return this.evaluate(`(selector, ...args) => (${source(fn)})(Array.from(document.querySelectorAll(selector)), ...args)`, selector, ...args);
    }

    $eval(selector, fn, ...args) {
        return this.evaluate(`(selector, ...args) => {
            const el = document.querySelector(selector);
            if (!el) throw new Error('нет элемента ' + selector);
            return (${source(fn)})(el, ...args);
        }`, selector, ...args);
    }

    async waitForFunction(fn, { timeout = 30000 } = {}, ...args) {
        const started = Date.now();
        for (;;) {
            if (await this.evaluate(fn, ...args).catch(() => false)) return;
            if (Date.now() - started > timeout) throw new Error(`не дождался условия за ${timeout} мс: ${source(fn).slice(0, 120)}`);
            await new Promise(r => setTimeout(r, 200));
        }
    }

    waitForSelector(selector, { timeout = 30000 } = {}) {
        return this.waitForFunction('selector => Boolean(document.querySelector(selector))', { timeout }, selector);
    }

    click(selector) {
        return this.$eval(selector, el => el.click());
    }

    select(selector, value) {
        return this.$eval(selector, (el, v) => {
            el.value = v;
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }, value);
    }

    async screenshot({ path: file }) {
        const { value } = await this.inTab(raw => raw('WebDriver:TakeScreenshot', { full: true }));
        fs.writeFileSync(file, Buffer.from(value, 'base64'));
    }

    async setViewport() { /* размер вкладки задаёт окно Firefox */ }

    on() { /* консоль страниц Marionette не пересылает */ }

    close() {
        return this.inTab(raw => raw('WebDriver:CloseWindow'));
    }
}

/**
 * Запуск Firefox с Marionette.
 * @param {{executablePath: string, headless?: boolean, prefs?: Record<string, string|number|boolean>}} o
 */
export async function launchFirefox({ executablePath, headless = true, prefs = {} }) {
    const port = 28000 + Math.floor(Math.random() * 1000);
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'videoloader-ff-'));
    const all = {
        'marionette.port': port,
        'browser.shell.checkDefaultBrowser': false,
        'browser.startup.homepage_override.mstone': 'ignore',
        'datareporting.policy.dataSubmissionEnabled': false,
        'toolkit.telemetry.reportingpolicy.firstRun': false,
        ...prefs
    };
    fs.writeFileSync(path.join(profile, 'user.js'),
        Object.entries(all).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('\n'));
    const proc = spawn(executablePath, ['-marionette', ...(headless ? ['-headless'] : []), '-no-remote', '-profile', profile], {
        stdio: 'ignore',
        env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' }
    });
    const m = await Marionette.connect(port);
    // Первое окно сессии — им пользуется первая newPage().
    let spare = (await m.cmd('WebDriver:GetWindowHandles'))[0];

    /** Новая вкладка; extensionUrl — открыть в ней страницу расширения. */
    async function openTab(extensionUrl) {
        const handle = await m.exclusive(async raw => {
            if (!extensionUrl && spare) {
                const h = spare;
                spare = null;
                return h;
            }
            const before = await raw('WebDriver:GetWindowHandles');
            if (!extensionUrl) return (await raw('WebDriver:NewWindow', { type: 'tab', focus: false })).handle;
            await raw('Marionette:SetContext', { value: 'chrome' });
            try {
                await raw('WebDriver:ExecuteScript', {
                    script: 'const w = Services.wm.getMostRecentWindow("navigator:browser");'
                        + 'w.gBrowser.addTab(arguments[0], { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });',
                    args: [extensionUrl]
                });
            } finally {
                await raw('Marionette:SetContext', { value: 'content' });
            }
            for (let i = 0; i < 50; i++) {
                const found = (await raw('WebDriver:GetWindowHandles')).find(h => !before.includes(h));
                if (found) return found;
                await new Promise(r => setTimeout(r, 100));
            }
            throw new Error(`вкладка ${extensionUrl} не открылась`);
        });
        const page = new Page(m, handle);
        if (extensionUrl) {
            page.currentUrl = extensionUrl;
            await page.waitForFunction('() => document.readyState === "complete"');
        }
        return page;
    }

    return {
        newPage: () => openTab(null),
        /** Страница расширения (moz-extension://…) в новой вкладке. */
        openExtensionPage: url => openTab(url),
        async installExtension(dir) {
            const { value } = await m.cmd('Addon:Install', { path: dir, temporary: true });
            return value;
        },
        async close() {
            await m.cmd('Marionette:Quit').catch(() => {});
            m.sock.destroy();
            await new Promise(resolve => {
                if (proc.exitCode != null) return resolve();
                const t = setTimeout(() => { proc.kill(); resolve(); }, 5000);
                proc.once('exit', () => { clearTimeout(t); resolve(); });
            });
            fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
        }
    };
}
