// services/marketing/marketingApprovalPdfService.js
//
// PDF de autorização de uma solicitação de marketing aprovada. Renderiza
// HTML → PDF via Playwright (mesmo padrão do certificatePdfService do Academy).
// Serve como comprovante formal: dados da ficha, itens com valores e o bloco
// de autorização com cada perfil, quem decidiu, quando e a ressalva (se houver).
//
// Uso: const buffer = await marketingApprovalPdfService.render({ request });

import dayjs from 'dayjs';
import 'dayjs/locale/pt-br.js';

dayjs.locale('pt-br');

const BRAND_PRIMARY = '#0F172A'; // slate-900
const BRAND_ACCENT = '#0EA5E9';  // sky-500

const DECISION_LABEL = {
    approved: 'Aprovado',
    approved_with_notes: 'Aprovado com ressalva',
    rejected: 'Reprovado',
};
const STATUS_LABEL = {
    approved: 'APROVADA',
    approved_with_notes: 'APROVADA COM RESSALVA',
    rejected: 'REPROVADA',
    pending: 'PENDENTE',
    cancelled: 'CANCELADA',
};

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtDate = (d) => (d ? dayjs(d).format('DD/MM/YYYY') : '-');
const fmtDateTime = (d) => (d ? dayjs(d).format('DD/MM/YYYY [às] HH:mm') : '-');

function buildHtml(request) {
    const items = Array.isArray(request.items) && request.items.length
        ? request.items
        : [{ name: request.description, description: null, amount: request.amount }];

    const itemRows = items.map((it) => `
        <tr>
          <td>${escapeHtml(it.name)}</td>
          <td class="muted">${escapeHtml(it.description || '-')}</td>
          <td class="num">${brl(it.amount)}</td>
        </tr>`).join('');

    const decisionRows = (request.decisions || []).map((d) => `
        <tr>
          <td>${escapeHtml(d.profile?.name || '-')}</td>
          <td>${escapeHtml(DECISION_LABEL[d.decision] || d.decision)}</td>
          <td>${escapeHtml(d.user?.username || '-')}</td>
          <td>${escapeHtml(fmtDateTime(d.created_at || d.createdAt))}</td>
          <td class="muted">${escapeHtml(d.comment || '-')}</td>
        </tr>`).join('');

    const statusLabel = STATUS_LABEL[request.status] || request.status;
    const isApproved = request.status === 'approved' || request.status === 'approved_with_notes';

    return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8" />
<title>Autorização ${escapeHtml(request.protocol)}</title>
<style>
  @page { size: A4 portrait; margin: 16mm 16mm 18mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; font-family: 'Helvetica Neue', Arial, sans-serif; color: ${BRAND_PRIMARY}; font-size: 11pt; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid ${BRAND_PRIMARY}; padding-bottom: 10px; margin-bottom: 16px; }
  .brand { font-size: 15pt; font-weight: 800; letter-spacing: 1px; text-transform: uppercase; }
  .brand small { display: block; font-size: 8pt; font-weight: 400; opacity: .6; letter-spacing: 1px; margin-top: 3px; }
  .doc-title { text-align: right; }
  .doc-title .proto { font-family: 'Courier New', monospace; font-size: 16pt; font-weight: 700; }
  .doc-title .kicker { font-size: 8pt; letter-spacing: 3px; text-transform: uppercase; opacity: .55; }
  .status { display: inline-block; margin-top: 6px; padding: 4px 12px; border-radius: 999px; font-size: 9pt; font-weight: 700; letter-spacing: .5px;
            color: #fff; background: ${isApproved ? '#059669' : request.status === 'rejected' ? '#dc2626' : '#64748b'}; }
  h2 { font-size: 9pt; letter-spacing: 2px; text-transform: uppercase; opacity: .55; margin: 20px 0 8px; border-bottom: 1px solid #e5e7eb; padding-bottom: 3px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 24px; }
  .field .label { font-size: 8pt; text-transform: uppercase; letter-spacing: 1px; opacity: .5; }
  .field .value { font-size: 11pt; }
  table { width: 100%; border-collapse: collapse; margin-top: 4px; }
  th, td { text-align: left; padding: 7px 8px; font-size: 10pt; border-bottom: 1px solid #eef2f6; vertical-align: top; }
  th { font-size: 8pt; text-transform: uppercase; letter-spacing: 1px; opacity: .55; border-bottom: 1.5px solid #cbd5e1; }
  td.num, th.num { text-align: right; font-family: 'Courier New', monospace; white-space: nowrap; }
  td.muted { opacity: .7; }
  .total-row td { font-weight: 700; border-top: 2px solid ${BRAND_PRIMARY}; border-bottom: none; font-size: 11pt; }
  .accent { color: ${BRAND_ACCENT}; }
  .footer { position: fixed; bottom: 8mm; left: 16mm; right: 16mm; display: flex; justify-content: space-between;
            font-size: 7.5pt; opacity: .55; border-top: 1px solid #e5e7eb; padding-top: 4px; }
</style></head>
<body>
  <div class="head">
    <div class="brand">Menin<small>Marketing · Autorização de Solicitação</small></div>
    <div class="doc-title">
      <div class="kicker">Protocolo</div>
      <div class="proto">${escapeHtml(request.protocol)}</div>
      <div class="status">${escapeHtml(statusLabel)}</div>
    </div>
  </div>

  <div class="grid">
    <div class="field"><div class="label">Tipo</div><div class="value">${escapeHtml(request.type_label)}</div></div>
    <div class="field"><div class="label">Solicitante</div><div class="value">${escapeHtml(request.requester?.username || '-')}</div></div>
    <div class="field"><div class="label">Centro de custo</div><div class="value">${escapeHtml(request.cost_center_name ? `${request.cost_center_name} (CC ${request.cost_center_id})` : '-')}</div></div>
    <div class="field"><div class="label">Fornecedor</div><div class="value">${escapeHtml(request.supplier || '-')}</div></div>
    <div class="field"><div class="label">Prazo</div><div class="value">${escapeHtml(fmtDate(request.due_date))}</div></div>
    <div class="field"><div class="label">Criada em</div><div class="value">${escapeHtml(fmtDateTime(request.created_at || request.createdAt))}</div></div>
  </div>

  <h2>Itens da solicitação</h2>
  <table>
    <thead><tr><th>Item</th><th>Descrição</th><th class="num">Valor</th></tr></thead>
    <tbody>
      ${itemRows}
      <tr class="total-row"><td colspan="2">Total</td><td class="num accent">${brl(request.amount)}</td></tr>
    </tbody>
  </table>

  ${request.justification ? `<h2>Justificativa</h2><div>${escapeHtml(request.justification)}</div>` : ''}

  <h2>Autorização</h2>
  <table>
    <thead><tr><th>Perfil</th><th>Decisão</th><th>Responsável</th><th>Data</th><th>Observações / Ressalva</th></tr></thead>
    <tbody>${decisionRows || '<tr><td colspan="5" class="muted">Sem decisões registradas.</td></tr>'}</tbody>
  </table>

  <div class="footer">
    <span>Documento gerado eletronicamente pelo Menin Office.</span>
    <span>Emitido em ${escapeHtml(fmtDateTime(new Date()))}</span>
  </div>
</body></html>`;
}

const marketingApprovalPdfService = {
    /** @returns {Promise<Buffer>} bytes do PDF */
    async render({ request } = {}) {
        if (!request?.protocol) throw new Error('Solicitação inválida.');
        const html = buildHtml(request);

        let chromium;
        try {
            ({ chromium } = await import('playwright'));
        } catch (err) {
            throw new Error('Geração de PDF indisponível: pacote "playwright" não instalado.');
        }

        const browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });
        try {
            const ctx = await browser.newContext();
            const page = await ctx.newPage();
            await page.setContent(html, { waitUntil: 'load' });
            const pdf = await page.pdf({
                format: 'A4',
                printBackground: true,
                preferCSSPageSize: true,
            });
            return pdf;
        } finally {
            await browser.close().catch(() => {});
        }
    },
};

export default marketingApprovalPdfService;
