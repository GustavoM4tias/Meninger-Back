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
    console.error('❌ .env incompleto: EMAIL_HOST, EMAIL_USER, EMAIL_PASS, EMAIL_FROM');
}

const transporter = nodemailer.createTransport({
    host: EMAIL_HOST,
    port: EMAIL_PORT,
    secure: EMAIL_SECURE, // 465 true, 587 false (STARTTLS)
    auth: { user: EMAIL_USER, pass: EMAIL_PASS },
    tls: {
        // rejectUnauthorized=false aceita certificados self-signed
        rejectUnauthorized: process.env.EMAIL_TLS_REJECT_UNAUTHORIZED !== 'false',
    },
});

const TPL_DIR = path.resolve(process.cwd(), 'email/templates');
const LAYOUTS_DIR = path.join(TPL_DIR, 'layouts');
const PARTIALS_DIR = path.join(TPL_DIR, 'partials');

const templateCache = new Map();

// helpers úteis
Handlebars.registerHelper('eq', (a, b) => a === b);
Handlebars.registerHelper('and', (a, b) => a && b);
Handlebars.registerHelper('or', (a, b) => a || b);

// carrega parciais 1x
for (const f of fs.readdirSync(PARTIALS_DIR)) {
    const name = path.basename(f, '.hbs');
    const src = fs.readFileSync(path.join(PARTIALS_DIR, f), 'utf-8');
    Handlebars.registerPartial(name, src);
}

// layout base helper
function wrapWithLayout(html, { title = 'Notificação', previewText = '' } = {}) {
    const layoutSrc = fs.readFileSync(path.join(LAYOUTS_DIR, 'base.hbs'), 'utf-8');
    const layoutTpl = Handlebars.compile(layoutSrc);
    return layoutTpl({ title, previewText, content: new Handlebars.SafeString(html) });
}

// mapa de assunto e preview por tipo
const META = {
    'event.created': {
        subject: (d) => `Novo evento: ${d.title || ''}`,
        preview: (d) => `Quando: ${d.eventDateFormatted || ''}`,
        file: 'event.created.hbs',
    },
    'event.reminder': {
        subject: (d) => `Lembrete: ${d.title || 'Evento'}`,
        preview: (d) => `Começa em breve • ${d.eventDateFormatted || ''}`,
        file: 'event.reminder.hbs',
    },
    'support.opened': {
        subject: (d) => `Chamado #${d.ticketId} aberto`,
        preview: (d) => d.summary || 'Recebemos sua solicitação',
        file: 'support.opened.hbs',
    },
    'support.updated': {
        subject: (d) => `Chamado #${d.ticketId} atualizado`,
        preview: (d) => d.latestUpdate || 'Atualização no seu chamado',
        file: 'support.updated.hbs',
    },
    'invite.user': {
        subject: (d) => `Convite para acessar ${d.productName || 'o sistema'}`,
        preview: () => 'Crie sua conta em poucos cliques',
        file: 'invite.user.hbs',
    },
    'invite.microsoft.user': {
        subject: () => `Você foi adicionado ao Menin Office`,
        preview: (d) => `Olá ${d.name || ''}! Acesse com sua conta Microsoft.`,
        file: 'invite.microsoft.user.hbs',
    },
    'generic.notification': {
        subject: (d) => d.title || 'Notificação',
        preview: (d) => d.preview || '',
        file: 'generic.notification.hbs',
    },
    'auth.academy.code': {
        subject: () => `Seu código de acesso`,
        preview: () => `Use o código para entrar no Academy`,
        file: 'auth.academy.code.hbs',
    },
    'auth.password.reset': {
        subject: () => `Seu código para alterar a senha é`,
        preview: () => `Use o código para redefinir sua senha`,
        file: 'auth.password.reset.hbs',
    },
    'supplier.rid.request': {
        subject: (d) => `Solicitação de cadastro de fornecedor: ${d.providerName || d.providerCnpj || ''}`,
        preview: (d) => `Solicitado por ${d.requesterName || 'usuário do sistema'}`,
        file: 'supplier.rid.request.hbs',
    },
    'meeting.report': {
        subject: (d) => `Relatório de Reunião: ${d.subject || 'Reunião'}`,
        preview: (d) => d.resumoPreview || 'Resumo e ações gerados por IA',
        file: 'meeting.report.hbs',
    },
};

function compileTemplateOnce(file) {
    if (templateCache.has(file)) return templateCache.get(file);
    const src = fs.readFileSync(path.join(TPL_DIR, file), 'utf-8');
    const tpl = Handlebars.compile(src);
    templateCache.set(file, tpl);
    return tpl;
}

/**
 * Envia um e-mail por tipo.
 * @param {string} type
 * @param {string|string[]} to
 * @param {object} data
 * @param {object} [options]
 * @param {string|string[]} [options.cc]        - Emails em cópia
 * @param {Array}           [options.attachments] - Nodemailer attachments array
 */
export async function sendEmail(type, to, data = {}, options = {}) {
    const cfg = META[type];
    if (!cfg) throw new Error(`Tipo desconhecido: ${type}`);

    const tpl = compileTemplateOnce(cfg.file);
    const innerHtml = tpl(data);
    const html = wrapWithLayout(innerHtml, {
        title: cfg.subject(data),
        previewText: cfg.preview(data),
    });

    const mailOptions = {
        from: EMAIL_FROM,
        to: Array.isArray(to) ? to.join(',') : to,
        subject: cfg.subject(data),
        html,
    };

    if (options.cc) {
        mailOptions.cc = Array.isArray(options.cc) ? options.cc.join(',') : options.cc;
    }
    if (options.attachments?.length) {
        mailOptions.attachments = options.attachments;
    }

    return transporter.sendMail(mailOptions);
}
