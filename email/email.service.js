// api/email/email.service.js
import fs from 'fs';
import path from 'path';
import Handlebars from 'handlebars';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
dotenv.config();

const EMAIL_HOST = process.env.EMAIL_HOST;
const EMAIL_PORT = Number(process.env.EMAIL_PORT || 587);
const EMAIL_SECURE = /^(1|true|yes)$/i.test(String(process.env.EMAIL_SECURE || 'false'));
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const EMAIL_FROM = process.env.EMAIL_FROM || EMAIL_USER;

if (!EMAIL_HOST || !EMAIL_USER || !EMAIL_PASS || !EMAIL_FROM) {
    console.error('[email] ENV incompleto', {
        EMAIL_HOST: !!EMAIL_HOST,
        EMAIL_USER: !!EMAIL_USER,
        EMAIL_PASS: !!EMAIL_PASS,
        EMAIL_FROM: !!EMAIL_FROM,
    });
}

export const transporter = nodemailer.createTransport({
    host: EMAIL_HOST,
    port: EMAIL_PORT,
    secure: EMAIL_SECURE,
    auth: { user: EMAIL_USER, pass: EMAIL_PASS },
    requireTLS: !EMAIL_SECURE,

    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,

    tls: {
        minVersion: 'TLSv1.2',
        rejectUnauthorized: process.env.EMAIL_TLS_REJECT_UNAUTHORIZED !== 'false',
    },
});

// ✅ verify no boot (loga se Railway consegue conectar)
export async function verifySmtp() {
    const cfg = { host: EMAIL_HOST, port: EMAIL_PORT, secure: EMAIL_SECURE, user: EMAIL_USER };
    const t0 = Date.now();
    try {
        await transporter.verify();
        console.info('[email] SMTP verify OK', { ...cfg, ms: Date.now() - t0 });
        return { ok: true, ...cfg, ms: Date.now() - t0 };
    } catch (err) {
        console.error('[email] SMTP verify FAIL', { ...cfg, ms: Date.now() - t0, err: err?.message || err });
        return { ok: false, ...cfg, ms: Date.now() - t0, err: err?.message || String(err) };
    }
}

// chama automaticamente no load do módulo (sem travar)
verifySmtp().catch(() => { });

// ---------------- templates (seu código) ----------------
const TPL_DIR = path.resolve(process.cwd(), 'email/templates');
const LAYOUTS_DIR = path.join(TPL_DIR, 'layouts');
const PARTIALS_DIR = path.join(TPL_DIR, 'partials');

const templateCache = new Map();

Handlebars.registerHelper('eq', (a, b) => a === b);
Handlebars.registerHelper('and', (a, b) => a && b);
Handlebars.registerHelper('or', (a, b) => a || b);

for (const f of fs.readdirSync(PARTIALS_DIR)) {
    const name = path.basename(f, '.hbs');
    const src = fs.readFileSync(path.join(PARTIALS_DIR, f), 'utf-8');
    Handlebars.registerPartial(name, src);
}

function wrapWithLayout(html, { title = 'Notificação', previewText = '' } = {}) {
    const layoutSrc = fs.readFileSync(path.join(LAYOUTS_DIR, 'base.hbs'), 'utf-8');
    const layoutTpl = Handlebars.compile(layoutSrc);
    return layoutTpl({ title, previewText, content: new Handlebars.SafeString(html) });
}

const META = {
    'auth.academy.code': {
        subject: () => `Seu código de acesso`,
        preview: () => `Use o código para entrar no Academy`,
        file: 'auth.academy.code.hbs',
    },
    // ... mantenha os outros tipos como estão
};

function compileTemplateOnce(file) {
    if (templateCache.has(file)) return templateCache.get(file);
    const src = fs.readFileSync(path.join(TPL_DIR, file), 'utf-8');
    const tpl = Handlebars.compile(src);
    templateCache.set(file, tpl);
    return tpl;
}

// ---------------- helpers retry/timeout ----------------
function withTimeout(promise, ms, label = 'timeout') {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
    ]);
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

export async function sendEmail(type, to, data = {}) {
    const cfg = META[type];
    if (!cfg) throw new Error(`Tipo desconhecido: ${type}`);

    const tpl = compileTemplateOnce(cfg.file);
    const innerHtml = tpl(data);
    const html = wrapWithLayout(innerHtml, {
        title: cfg.subject(data),
        previewText: cfg.preview(data),
    });

    const mail = {
        from: EMAIL_FROM,
        to: Array.isArray(to) ? to.join(',') : to,
        subject: cfg.subject(data),
        html,
    };

    const t0 = Date.now();
    try {
        const info = await withTimeout(transporter.sendMail(mail), 12_000, 'sendMail timeout');

        // ✅ LOGA retorno do SMTP (muito importante)
        console.info('[email] sendMail OK', {
            ms: Date.now() - t0,
            to: mail.to,
            subject: mail.subject,
            messageId: info?.messageId,
            accepted: info?.accepted,
            rejected: info?.rejected,
            response: info?.response,
        });

        return info;
    } catch (err) {
        console.error('[email] sendMail FAIL', {
            ms: Date.now() - t0,
            to: mail.to,
            subject: mail.subject,
            err: err?.message || err,
        });
        throw err;
    }
}

export async function sendEmailWithRetry(type, to, data = {}, opts = {}) {
    const retries = Number(opts.retries ?? 2);
    const timeoutMs = Number(opts.timeoutMs ?? 12_000);
    const backoffMs = Number(opts.backoffMs ?? 1500);

    let lastErr = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
        const t0 = Date.now();
        try {
            console.info('[email] attempt', { attempt: attempt + 1, total: retries + 1, type, to });
            const info = await withTimeout(sendEmail(type, to, data), timeoutMs, 'sendEmail timeout');
            console.info('[email] attempt OK', { attempt: attempt + 1, ms: Date.now() - t0 });
            return info;
        } catch (err) {
            lastErr = err;
            console.error('[email] attempt FAIL', {
                attempt: attempt + 1,
                ms: Date.now() - t0,
                err: err?.message || err,
            });

            if (attempt < retries) await sleep(backoffMs * (attempt + 1));
        }
    }

    throw lastErr;
}

// ✅ envio técnico simples (sem templates) para TEST_TO
export async function sendTestEmail() {
    const to = process.env.TEST_TO;
    if (!to) throw new Error('TEST_TO não configurado');

    const mail = {
        from: EMAIL_FROM,
        to,
        subject: `Teste SMTP - ${new Date().toISOString()}`,
        html: `<p>Teste SMTP OK. Host=${EMAIL_HOST} Port=${EMAIL_PORT} Secure=${EMAIL_SECURE}</p>`,
    };

    const info = await withTimeout(transporter.sendMail(mail), 12_000, 'sendMail timeout');
    console.info('[email] sendTestEmail OK', {
        to,
        messageId: info?.messageId,
        accepted: info?.accepted,
        rejected: info?.rejected,
        response: info?.response,
    });
    return info;
}
