// services/alerts/AlertAttachmentService.js
//
// Gera os anexos de um alerta a partir dos MESMOS blocos que o texto usa:
//   - gerarPdf   HTML de papel (AlertReportRenderer.renderHtml) → Playwright
//   - gerarXlsx  abas (AlertReportRenderer.xlsxSheets) → lib `xlsx`
//
// Quem chama decide o que fazer com os bytes (subir para a Meta, anexar no
// e-mail). Falha aqui nunca derruba o alerta: o AlertEngine cai para o
// template de texto e registra o erro.
//
// Playwright é carregado sob demanda (mesmo caminho do certificado do
// Academy): o `postinstall` instala o chromium em produção.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import tz from 'dayjs/plugin/timezone.js';
import { renderHtml, xlsxSheets, formatarValor } from './AlertReportRenderer.js';

dayjs.extend(utc); dayjs.extend(tz);

const DEFAULT_TZ = process.env.TIMEZONE || 'America/Sao_Paulo';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGO_PATH = path.resolve(__dirname, '../../assets/logo-menin-black.png');

let _logoDataUrl;
function logoDataUrl() {
    if (_logoDataUrl !== undefined) return _logoDataUrl;
    try {
        _logoDataUrl = `data:image/png;base64,${fs.readFileSync(LOGO_PATH).toString('base64')}`;
    } catch {
        _logoDataUrl = null;
    }
    return _logoDataUrl;
}

/** "Alerta - Reservas do dia - 14-09-2026.pdf" (sem caracteres que o WhatsApp/SO rejeitam). */
export function nomeArquivo(ruleName, ext, timezone = DEFAULT_TZ) {
    const base = String(ruleName || 'Alerta')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^A-Za-z0-9 _-]/g, ' ')
        .replace(/\s+/g, ' ').trim().slice(0, 60) || 'Alerta';
    return `Alerta - ${base} - ${dayjs().tz(timezone).format('DD-MM-YYYY')}.${ext}`;
}

/**
 * PDF do relatório.
 * @param {object} args
 * @param {object|Array} args.entrada   retorno da tool ou blocos
 * @param {string} args.ruleName
 * @param {string} [args.link]
 * @param {string} [args.timezone]
 * @returns {Promise<{ buffer: Buffer, filename: string, mimeType: string, ms: number }>}
 */
export async function gerarPdf({ entrada, ruleName, link = null, timezone = DEFAULT_TZ }) {
    const inicio = Date.now();
    const html = renderHtml(entrada, {
        ruleName,
        link,
        geradoEm: dayjs().tz(timezone).format('DD/MM/YYYY HH:mm'),
        logoDataUrl: logoDataUrl(),
    });

    let chromium;
    try {
        ({ chromium } = await import('playwright'));
    } catch {
        throw new Error('Geração de PDF indisponível: pacote "playwright" não instalado.');
    }

    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    try {
        const ctx = await browser.newContext({ viewport: { width: 900, height: 1200 } });
        const page = await ctx.newPage();
        await page.setContent(html, { waitUntil: 'load' });
        const buffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            preferCSSPageSize: true,
            margin: { top: '12mm', right: '12mm', bottom: '12mm', left: '12mm' },
        });
        return { buffer: Buffer.from(buffer), filename: nomeArquivo(ruleName, 'pdf', timezone), mimeType: 'application/pdf', ms: Date.now() - inicio };
    } finally {
        await browser.close().catch(() => {});
    }
}

// Formato de célula do Excel por tipo de coluna (valor fica numérico).
const FORMATO_CELULA = {
    currency: '"R$" #,##0.00',
    number:   '#,##0.##',
    percent:  '0.0"%"',
};

/**
 * Planilha com uma aba por dataset (+ Indicadores). Devolve null quando não
 * há nada tabular para exportar.
 * @returns {Promise<{ buffer: Buffer, filename: string, mimeType: string } | null>}
 */
export async function gerarXlsx({ entrada, ruleName, timezone = DEFAULT_TZ }) {
    const abas = xlsxSheets(entrada);
    if (!abas.length) return null;

    const XLSX = (await import('xlsx')).default;
    const wb = XLSX.utils.book_new();

    for (const aba of abas) {
        const cabecalho = aba.columns.map(c => c.label);
        const linhas = aba.rows.map(r => aba.columns.map(c => celula(r[c.key], c.type)));
        const ws = XLSX.utils.aoa_to_sheet([cabecalho, ...linhas]);

        // Formato numérico por coluna + largura pelo conteúdo.
        aba.columns.forEach((c, ci) => {
            const fmt = FORMATO_CELULA[c.type];
            if (fmt) {
                for (let ri = 1; ri <= aba.rows.length; ri++) {
                    const ref = XLSX.utils.encode_cell({ r: ri, c: ci });
                    if (ws[ref] && typeof ws[ref].v === 'number') ws[ref].z = fmt;
                }
            }
        });
        ws['!cols'] = aba.columns.map((c, ci) => {
            const maior = Math.max(String(c.label).length, ...aba.rows.slice(0, 200).map(r => String(formatarValor(r[c.key], c.type)).length));
            return { wch: Math.min(48, Math.max(10, maior + 2)) };
        });
        XLSX.utils.book_append_sheet(wb, ws, aba.name);
    }

    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    return {
        buffer: Buffer.from(buffer),
        filename: nomeArquivo(ruleName, 'xlsx', timezone),
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
}

// Valor da célula: número fica número (inclusive "R$ 1.234,56" e "13,5%"),
// data vira Date, o resto texto.
function celula(v, tipo) {
    if (v == null || v === '') return null;
    if (tipo === 'currency' || tipo === 'number' || tipo === 'percent') {
        if (typeof v === 'number') return v;
        const s = String(v).replace(/[^\d,.-]/g, '');
        if (!/\d/.test(s)) return String(v);
        const n = Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/(\.\d{3})+(?!\d)/g, m => m.replace(/\./g, '')));
        return Number.isFinite(n) ? n : String(v);
    }
    if (tipo === 'date') {
        const d = dayjs(v);
        return d.isValid() ? d.toDate() : String(v);
    }
    if (typeof v === 'boolean') return v ? 'Sim' : 'Não';
    return typeof v === 'number' ? v : String(v);
}

export default { gerarPdf, gerarXlsx, nomeArquivo };
