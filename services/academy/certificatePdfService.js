// services/academy/certificatePdfService.js
//
// Geração de PDF do certificado.
// Renderiza HTML→PDF via Playwright (já instalado para outras automações)
// e injeta QR code (qrcode lib) apontando para a URL pública de verificação.
//
// Uso:
//   const buffer = await certificatePdfService.render({ certificate, verifyUrl });

import dayjs from 'dayjs';
import 'dayjs/locale/pt-br.js';

dayjs.locale('pt-br');

const BRAND_PRIMARY = '#0F172A';  // slate-900
const BRAND_ACCENT = '#0EA5E9';   // sky-500
const ACADEMY_URL_BASE = process.env.ACADEMY_URL_BASE || 'https://academy.menin.com.br';

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatDate(d) {
    if (!d) return '';
    return dayjs(d).format('DD [de] MMMM [de] YYYY');
}

async function buildQrDataUrl(text) {
    // `qrcode` é uma dependência OPCIONAL. Se não estiver instalada, o PDF
    // é gerado sem a imagem do QR — o código de verificação em texto continua
    // presente, então o certificado segue plenamente verificável.
    // Para ativar o QR: `npm install qrcode`.
    try {
        const QRCode = (await import('qrcode')).default;
        return QRCode.toDataURL(text, {
            errorCorrectionLevel: 'M',
            margin: 1,
            scale: 8,
            color: { dark: BRAND_PRIMARY, light: '#FFFFFF' },
        });
    } catch (err) {
        console.warn('[certificatePdf] qrcode não instalado — PDF sem QR. Rode "npm install qrcode" para ativar.');
        return null;
    }
}

function buildHtml({ certificate, verifyUrl, qrDataUrl }) {
    const userName = escapeHtml(certificate.userName || 'Aluno');
    const trackTitle = escapeHtml(certificate.trackTitle || 'Trilha');
    const code = escapeHtml(certificate.code);
    const issuedAt = escapeHtml(formatDate(certificate.issuedAt));
    const expires = certificate.expiresAt
        ? `Válido até ${escapeHtml(formatDate(certificate.expiresAt))}`
        : 'Sem validade definida';

    return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<title>Certificado — ${userName}</title>
<style>
  @page { size: A4 landscape; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; font-family: 'Helvetica Neue', Arial, sans-serif; color: ${BRAND_PRIMARY}; }

  .page {
    position: relative;
    width: 297mm; height: 210mm;
    background: #fff;
    padding: 22mm 26mm;
    overflow: hidden;
  }

  /* Watermark decorativo */
  .frame {
    position: absolute; inset: 8mm;
    border: 2px solid ${BRAND_PRIMARY};
    border-radius: 6mm;
    pointer-events: none;
  }
  .corner-tl, .corner-br {
    position: absolute;
    width: 24mm; height: 24mm;
    border: 6px solid ${BRAND_ACCENT};
    border-radius: 3mm;
  }
  .corner-tl { top: 16mm; left: 18mm; border-right: 0; border-bottom: 0; }
  .corner-br { bottom: 16mm; right: 18mm; border-left: 0; border-top: 0; }

  .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12mm; }
  .brand { font-size: 14pt; font-weight: 800; letter-spacing: 2px; text-transform: uppercase; }
  .brand small { display: block; font-size: 8pt; font-weight: 400; opacity: .6; letter-spacing: 1px; margin-top: 2pt; }

  .kicker { font-size: 11pt; letter-spacing: 4px; text-transform: uppercase; opacity: .6; margin-bottom: 6mm; }

  h1 { margin: 0; font-size: 48pt; font-weight: 800; line-height: 1.05; letter-spacing: -0.5pt; }
  .user-name { margin: 8mm 0 4mm; font-size: 26pt; font-weight: 700; color: ${BRAND_ACCENT}; }
  .lead { font-size: 13pt; line-height: 1.5; max-width: 200mm; opacity: .85; }
  .track-title { font-weight: 700; color: ${BRAND_PRIMARY}; }

  .meta {
    margin-top: 14mm;
    display: flex; gap: 14mm; align-items: flex-end; justify-content: space-between;
  }
  .meta-block { font-size: 10pt; }
  .meta-block strong { display: block; font-size: 12pt; margin-bottom: 1mm; }
  .meta-block .label { text-transform: uppercase; letter-spacing: 2px; font-size: 8pt; opacity: .55; margin-bottom: 2mm; }

  .qr-card { text-align: center; }
  .qr-card img { width: 28mm; height: 28mm; display: block; margin: 0 auto 2mm; }
  .qr-card .code-mono { font-family: 'Courier New', Courier, monospace; font-size: 8pt; opacity: .7; }

  .footer {
    position: absolute; bottom: 14mm; left: 26mm; right: 26mm;
    display: flex; justify-content: space-between; align-items: center;
    font-size: 8pt; opacity: .6; padding-top: 4mm; border-top: 1px solid #e5e7eb;
  }
  .footer .url { font-family: 'Courier New', Courier, monospace; }
</style>
</head>
<body>
  <div class="page">
    <div class="frame"></div>
    <div class="corner-tl"></div>
    <div class="corner-br"></div>

    <div class="header">
      <div class="brand">
        Menin Academy
        <small>Plataforma de Aprendizagem Corporativa</small>
      </div>
      <div class="brand" style="text-align:right;">
        ${issuedAt.toUpperCase()}
        <small>${expires.toUpperCase()}</small>
      </div>
    </div>

    <div class="kicker">Certificado de Conclusão</div>
    <h1>Certificamos que</h1>
    <div class="user-name">${userName}</div>
    <p class="lead">
      concluiu, com aproveitamento, a trilha de aprendizagem
      <span class="track-title">${trackTitle}</span>, cumprindo todos os itens
      obrigatórios e atendendo aos critérios de avaliação estabelecidos.
    </p>

    <div class="meta">
      <div class="meta-block">
        <div class="label">Emitido em</div>
        <strong>${issuedAt}</strong>
      </div>
      <div class="meta-block">
        <div class="label">Código de Verificação</div>
        <strong class="code-mono" style="font-family: 'Courier New', Courier, monospace;">${code}</strong>
      </div>
      ${qrDataUrl ? `<div class="qr-card">
        <img src="${qrDataUrl}" alt="QR de verificação" />
        <div class="code-mono">Aponte a câmera</div>
      </div>` : ''}
    </div>

    <div class="footer">
      <div>Documento gerado eletronicamente. Autenticidade verificável em:</div>
      <div class="url">${escapeHtml(verifyUrl)}</div>
    </div>
  </div>
</body>
</html>`;
}

const certificatePdfService = {
    /**
     * Renderiza o PDF do certificado.
     * @returns {Promise<Buffer>} bytes do PDF
     */
    async render({ certificate, verifyUrlBase = ACADEMY_URL_BASE } = {}) {
        if (!certificate?.code) throw new Error('Certificado inválido.');

        const verifyUrl = `${verifyUrlBase.replace(/\/$/, '')}/cert/${encodeURIComponent(certificate.code)}`;
        const qrDataUrl = await buildQrDataUrl(verifyUrl);
        const html = buildHtml({ certificate, verifyUrl, qrDataUrl });

        // playwright é carregado sob demanda — não bloqueia o boot do servidor
        // caso o pacote não esteja instalado no ambiente.
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
            const ctx = await browser.newContext({ viewport: { width: 1240, height: 877 } });
            const page = await ctx.newPage();
            await page.setContent(html, { waitUntil: 'load' });
            const pdf = await page.pdf({
                format: 'A4',
                landscape: true,
                printBackground: true,
                preferCSSPageSize: true,
                margin: { top: 0, right: 0, bottom: 0, left: 0 },
            });
            return pdf;
        } finally {
            await browser.close().catch(() => { });
        }
    },
};

export default certificatePdfService;
