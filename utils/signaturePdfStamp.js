// utils/signaturePdfStamp.js
// Adiciona uma página final de certificado + rodapé em cada página do PDF assinado.

import fetch from 'node-fetch';
import { PDFDocument, rgb, StandardFonts, LineCapStyle } from 'pdf-lib';
import supabase from '../config/supabaseClient.js';

const BUCKET = process.env.SUPABASE_BUCKET || 'Office Bucket';

// ── Cores ─────────────────────────────────────────────────────────────────────
const COLOR = {
  navy: rgb(0.05, 0.15, 0.35),
  blue: rgb(0.13, 0.35, 0.75),
  lightBlue: rgb(0.88, 0.93, 1.0),
  gray: rgb(0.45, 0.45, 0.45),
  lightGray: rgb(0.93, 0.93, 0.93),
  white: rgb(1, 1, 1),
  black: rgb(0, 0, 0),
  green: rgb(0.10, 0.55, 0.28),
  greenBg: rgb(0.90, 0.97, 0.93),
};

// ── Helpers de compatibilidade WinAnsi ────────────────────────────────────────
function sanitizePdfText(value = '') {
  return String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, '')
    .trim();
}

function truncate(str, max) {
  const safe = sanitizePdfText(str || '');
  if (!safe) return '';
  return safe.length > max ? safe.slice(0, max - 3) + '...' : safe;
}

function fmtDatetime(d) {
  if (!d) return '-';

  return sanitizePdfText(
    new Intl.DateTimeFormat('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZone: 'America/Sao_Paulo',
    }).format(new Date(d))
  );
}

// ── Download PDF from URL ─────────────────────────────────────────────────────
async function downloadPdfBytes(url) {
  const res = await fetch(url, { timeout: 15000 });
  if (!res.ok) throw new Error(`Falha ao baixar PDF: ${res.status}`);
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

// ── Upload PDF bytes to Supabase ──────────────────────────────────────────────
async function uploadPdfBytes(bytes, userId, signatureId) {
  const path = `office/signatures/${userId}/stamped-${signatureId}-${Date.now()}.pdf`;

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, bytes, { contentType: 'application/pdf', upsert: true });

  if (error) throw new Error(`Erro ao re-enviar PDF: ${error.message}`);

  const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return urlData?.publicUrl ?? null;
}

function drawCheckIcon(page, x, y, color) {
  page.drawLine({
    start: { x, y },
    end: { x: x + 4, y: y - 4 },
    thickness: 1.5,
    color,
    lineCap: LineCapStyle.Round,
  });

  page.drawLine({
    start: { x: x + 4, y: y - 4 },
    end: { x: x + 10, y: y + 4 },
    thickness: 1.5,
    color,
    lineCap: LineCapStyle.Round,
  });
}

// ── Adiciona rodapé em cada página ─────────────────────────────────────────────
async function stampExistingPages(pdfDoc, { signerName, verificationCode, signedAt }) {
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const pages = pdfDoc.getPages();
  const totalPages = pages.length;

  const label = sanitizePdfText(
    `Assinado digitalmente por ${signerName || '-'}  ·  ${verificationCode || '-'}  ·  ${fmtDatetime(signedAt)}`
  )
    .replace(/·/g, ' | ');

  for (let i = 0; i < totalPages; i++) {
    const page = pages[i];
    const { width } = page.getSize();
    const stripH = 18;
    const y = 0;

    // Fundo da faixa
    page.drawRectangle({
      x: 0,
      y,
      width,
      height: stripH,
      color: COLOR.navy,
    });

    // Linha separadora acima da faixa
    page.drawLine({
      start: { x: 0, y: y + stripH },
      end: { x: width, y: y + stripH },
      thickness: 0.5,
      color: COLOR.blue,
    });

    // Ícone desenhado em vez de caractere Unicode
    drawCheckIcon(page, 6, y + 8, COLOR.white);

    // Texto principal
    const maxLabelWidth = width - 60;
    const fontSize = 6.5;

    page.drawText(truncate(label, 140), {
      x: 20,
      y: y + 5,
      size: fontSize,
      font: helvetica,
      color: COLOR.white,
      maxWidth: maxLabelWidth,
    });

    // Número de página
    const pageLabel = `${i + 1}/${totalPages}`;
    const labelWidth = helvetica.widthOfTextAtSize(pageLabel, 6);

    page.drawText(pageLabel, {
      x: width - labelWidth - 6,
      y: y + 5,
      size: 6,
      font: helvetica,
      color: rgb(0.7, 0.8, 1.0),
    });
  }
}

// ── Página de certificado ─────────────────────────────────────────────────────
async function addCertificatePage(
  pdfDoc,
  { documentName, signerName, signedAt, ipAddress, verificationCode, documentHash }
) {
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const courier = await pdfDoc.embedFont(StandardFonts.Courier);

  const page = pdfDoc.addPage([595.28, 841.89]); // A4
  const { width, height } = page.getSize();
  const margin = 40;
  const innerX = margin + 12;

  // Topo
  page.drawRectangle({
    x: 0,
    y: height - 100,
    width,
    height: 100,
    color: COLOR.navy,
  });

  page.drawRectangle({
    x: 0,
    y: height - 104,
    width,
    height: 4,
    color: COLOR.blue,
  });

  // Ícone circular
  const iconX = width / 2;
  const iconY = height - 60;

  page.drawCircle({ x: iconX, y: iconY, size: 26, color: COLOR.blue });
  page.drawCircle({ x: iconX, y: iconY, size: 22, color: COLOR.white });

  page.drawLine({
    start: { x: iconX - 8, y: iconY },
    end: { x: iconX - 2, y: iconY - 6 },
    thickness: 2.5,
    color: COLOR.navy,
    lineCap: LineCapStyle.Round,
  });

  page.drawLine({
    start: { x: iconX - 2, y: iconY - 6 },
    end: { x: iconX + 9, y: iconY + 7 },
    thickness: 2.5,
    color: COLOR.navy,
    lineCap: LineCapStyle.Round,
  });

  // Título
  const titleText = 'CERTIFICADO DE ASSINATURA DIGITAL';
  const titleWidth = helveticaBold.widthOfTextAtSize(titleText, 13);

  page.drawText(titleText, {
    x: (width - titleWidth) / 2,
    y: height - 130,
    size: 13,
    font: helveticaBold,
    color: COLOR.navy,
  });

  const subText = sanitizePdfText(
    'Menin Office - Assinatura com autenticacao de dois fatores'
  );
  const subWidth = helvetica.widthOfTextAtSize(subText, 8);

  page.drawText(subText, {
    x: (width - subWidth) / 2,
    y: height - 145,
    size: 8,
    font: helvetica,
    color: COLOR.gray,
  });

  page.drawLine({
    start: { x: margin, y: height - 155 },
    end: { x: width - margin, y: height - 155 },
    thickness: 1,
    color: COLOR.blue,
  });

  // Dados
  let y = height - 185;
  const lineH = 22;

  function drawRow(label, value, opts = {}) {
    page.drawText(sanitizePdfText(label), {
      x: innerX,
      y,
      size: 8,
      font: helveticaBold,
      color: COLOR.navy,
    });

    const valFont = opts.mono ? courier : helvetica;

    page.drawText(truncate(String(value || '-'), opts.maxChars || 80), {
      x: innerX + 120,
      y,
      size: opts.mono ? 7.5 : 8,
      font: valFont,
      color: opts.mono ? COLOR.gray : COLOR.black,
    });

    y -= lineH;
  }

  drawRow('Documento:', documentName);
  drawRow('Assinado por:', signerName);
  drawRow('Data e hora:', fmtDatetime(signedAt)); 

  y -= 4;
  page.drawLine({
    start: { x: innerX, y },
    end: { x: width - innerX, y },
    thickness: 0.5,
    color: COLOR.lightGray,
  });
  y -= 14;

  if (documentHash) {
    page.drawText('Hash SHA-256:', {
      x: innerX,
      y,
      size: 8,
      font: helveticaBold,
      color: COLOR.navy,
    });

    y -= 14;

    page.drawText(truncate(documentHash, 500), {
      x: innerX,
      y,
      size: 7,
      font: courier,
      color: COLOR.gray,
      maxWidth: width - innerX * 2,
    });

    y -= 20;
  }

  // Caixa do código
  const codeBoxH = 64;
  const codeBoxY = y - codeBoxH;

  page.drawRectangle({
    x: margin,
    y: codeBoxY,
    width: width - margin * 2,
    height: codeBoxH,
    color: COLOR.lightBlue,
    borderColor: COLOR.blue,
    borderWidth: 1.5,
  });

  page.drawText('CODIGO DE VERIFICACAO', {
    x: margin + 12,
    y: codeBoxY + codeBoxH - 16,
    size: 7.5,
    font: helveticaBold,
    color: COLOR.blue,
  });

  const codeText = sanitizePdfText(verificationCode || '----');
  const codeSize = 26;
  const codeWidth = helveticaBold.widthOfTextAtSize(codeText, codeSize);

  page.drawText(codeText, {
    x: (width - codeWidth) / 2,
    y: codeBoxY + 14,
    size: codeSize,
    font: helveticaBold,
    color: COLOR.navy,
  });

  y = codeBoxY - 20;

  const descLines = [
    'Este documento foi assinado eletronicamente com dupla autenticacao: senha pessoal',
    'e reconhecimento facial biometrico, garantindo a identidade do signatario.',
    'Use o codigo acima para verificar a autenticidade em: menin.office/verificar',
  ];

  for (const line of descLines) {
    page.drawText(sanitizePdfText(line), {
      x: margin,
      y,
      size: 7.5,
      font: helvetica,
      color: COLOR.gray,
      maxWidth: width - margin * 2,
    });
    y -= 13;
  }

  // Bordas decorativas
  page.drawRectangle({
    x: 8,
    y: 8,
    width: width - 16,
    height: height - 16,
    borderColor: COLOR.navy,
    borderWidth: 1.5,
    opacity: 0,
    borderOpacity: 1,
  });

  page.drawRectangle({
    x: 12,
    y: 12,
    width: width - 24,
    height: height - 24,
    borderColor: COLOR.blue,
    borderWidth: 0.4,
    opacity: 0,
    borderOpacity: 1,
  });

  // Rodapé
  page.drawRectangle({
    x: 0,
    y: 0,
    width,
    height: 28,
    color: COLOR.navy,
  });

  page.drawRectangle({
    x: 0,
    y: 28,
    width,
    height: 2,
    color: COLOR.blue,
  });

  const footerText = sanitizePdfText(
    'Menin Office | Assinatura Digital com Autenticacao Biometrica'
  );
  const ftw = helvetica.widthOfTextAtSize(footerText, 7.5);

  page.drawText(footerText, {
    x: (width - ftw) / 2,
    y: 9,
    size: 7.5,
    font: helvetica,
    color: COLOR.white,
  });
}

// ── Rodapé multi-assinatura em cada página ────────────────────────────────────
async function stampExistingPagesMulti(pdfDoc, { signerCount, verificationCode, signedAtFinal }) {
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const pages     = pdfDoc.getPages();
  const total     = pages.length;

  const label = sanitizePdfText(
    `${signerCount} assinatura(s) digital(is) valida(s)  |  ${verificationCode || '-'}  |  ${fmtDatetime(signedAtFinal)}`
  );

  for (let i = 0; i < total; i++) {
    const page = pages[i];
    const { width } = page.getSize();
    const stripH = 20;

    page.drawRectangle({ x: 0, y: 0, width, height: stripH, color: COLOR.navy });
    page.drawLine({ start: { x: 0, y: stripH }, end: { x: width, y: stripH }, thickness: 0.5, color: COLOR.blue });

    drawCheckIcon(page, 6, stripH - 10, COLOR.white);

    page.drawText(truncate(label, 140), {
      x: 20, y: 6, size: 6.5, font: helvetica, color: COLOR.white, maxWidth: width - 60,
    });

    const pgLabel  = `${i + 1}/${total}`;
    const pgWidth  = helvetica.widthOfTextAtSize(pgLabel, 6);
    page.drawText(pgLabel, {
      x: width - pgWidth - 6, y: 6, size: 6, font: helvetica, color: rgb(0.7, 0.8, 1.0),
    });
  }
}

// ── Página de certificado multi-assinatura ────────────────────────────────────
async function addMultiSignerCertificatePage(pdfDoc, {
  documentName, documentHash, verificationCode, signedAtFinal,
  signers,  // [{ name, signedAt, verificationCode }]
}) {
  const helvetica     = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const courier       = await pdfDoc.embedFont(StandardFonts.Courier);

  const page   = pdfDoc.addPage([595.28, 841.89]);
  const { width, height } = page.getSize();
  const margin = 40;
  const innerX = margin + 12;

  // ── Header ────────────────────────────────────────────────────────────────
  page.drawRectangle({ x: 0, y: height - 100, width, height: 100, color: COLOR.navy });
  page.drawRectangle({ x: 0, y: height - 104, width, height: 4, color: COLOR.blue });

  const iconX = width / 2;
  const iconY = height - 60;
  page.drawCircle({ x: iconX, y: iconY, size: 28, color: COLOR.blue });
  page.drawCircle({ x: iconX, y: iconY, size: 24, color: COLOR.white });
  page.drawLine({ start: { x: iconX - 8, y: iconY }, end: { x: iconX - 2, y: iconY - 6 }, thickness: 2.5, color: COLOR.navy, lineCap: LineCapStyle.Round });
  page.drawLine({ start: { x: iconX - 2, y: iconY - 6 }, end: { x: iconX + 9, y: iconY + 7 }, thickness: 2.5, color: COLOR.navy, lineCap: LineCapStyle.Round });

  const titleText  = 'CERTIFICADO DE ASSINATURA DIGITAL';
  const titleWidth = helveticaBold.widthOfTextAtSize(titleText, 13);
  page.drawText(titleText, { x: (width - titleWidth) / 2, y: height - 130, size: 13, font: helveticaBold, color: COLOR.navy });

  const subText  = sanitizePdfText(`Menin Office - Assinatura Conjunta com ${signers.length} Assinante(s)`);
  const subWidth = helvetica.widthOfTextAtSize(subText, 8);
  page.drawText(subText, { x: (width - subWidth) / 2, y: height - 145, size: 8, font: helvetica, color: COLOR.gray });

  page.drawLine({ start: { x: margin, y: height - 155 }, end: { x: width - margin, y: height - 155 }, thickness: 1, color: COLOR.blue });

  // ── Dados do documento ────────────────────────────────────────────────────
  let y      = height - 180;
  const rowH = 18;

  function drawField(label, value, opts = {}) {
    page.drawText(sanitizePdfText(label), { x: innerX, y, size: 7.5, font: helveticaBold, color: COLOR.navy });
    const fnt = opts.mono ? courier : helvetica;
    page.drawText(truncate(String(value || '-'), opts.max || 80), { x: innerX + 110, y, size: opts.mono ? 7 : 7.5, font: fnt, color: opts.mono ? COLOR.gray : COLOR.black });
    y -= rowH;
  }

  drawField('Documento:', documentName);
  drawField('Concluido em:', fmtDatetime(signedAtFinal));
  drawField('Total de assinantes:', `${signers.length} assinante(s)`);

  if (documentHash) {
    drawField('Hash SHA-256:', documentHash, { mono: true, max: 64 });
  }

  y -= 6;
  page.drawLine({ start: { x: innerX, y }, end: { x: width - innerX, y }, thickness: 0.5, color: COLOR.lightGray });
  y -= 16;

  // ── Lista de assinantes ───────────────────────────────────────────────────
  page.drawText('ASSINANTES', { x: innerX, y, size: 8, font: helveticaBold, color: COLOR.navy });
  y -= 12;

  const colW     = (width - innerX * 2 - 8) / 3;
  const sigRowH  = 40;

  for (let i = 0; i < signers.length; i++) {
    const s = signers[i];
    if (y - sigRowH < 50) {
      // Se ficar sem espaço, apenas compacta
      y -= 4;
    }

    const bx = innerX + (i % 3) * (colW + 4);

    // Se for uma nova linha de 3
    if (i % 3 === 0 && i !== 0) y -= sigRowH + 6;

    // Caixa do assinante
    page.drawRectangle({
      x: bx - 4, y: y - sigRowH + 4,
      width: colW, height: sigRowH - 2,
      color: COLOR.lightBlue,
      borderColor: COLOR.blue, borderWidth: 0.5,
    });

    // Checkmark pequeno
    drawCheckIcon(page, bx + 2, y - 8, COLOR.green);

    // Nome
    page.drawText(truncate(sanitizePdfText(s.name || '-'), 22), {
      x: bx + 14, y: y - 10, size: 7.5, font: helveticaBold, color: COLOR.navy,
    });

    // Data
    page.drawText(fmtDatetime(s.signedAt), {
      x: bx + 2, y: y - 21, size: 6, font: helvetica, color: COLOR.gray,
    });

    // Código individual
    page.drawText(sanitizePdfText(s.verificationCode || '-'), {
      x: bx + 2, y: y - 31, size: 6, font: courier, color: COLOR.blue,
    });

    // Na última coluna de cada linha avança y
    if ((i + 1) % 3 === 0 || i === signers.length - 1) {
      y -= sigRowH + 6;
    }
  }

  y -= 8;

  // ── Caixa do código final do documento ───────────────────────────────────
  const codeBoxH = 64;
  const codeBoxY = y - codeBoxH;

  page.drawRectangle({ x: margin, y: codeBoxY, width: width - margin * 2, height: codeBoxH, color: COLOR.lightBlue, borderColor: COLOR.blue, borderWidth: 1.5 });
  page.drawText('CODIGO FINAL DE VERIFICACAO DO DOCUMENTO', { x: margin + 12, y: codeBoxY + codeBoxH - 16, size: 7.5, font: helveticaBold, color: COLOR.blue });

  const codeText  = sanitizePdfText(verificationCode || '----');
  const codeSize  = 24;
  const codeWidth = helveticaBold.widthOfTextAtSize(codeText, codeSize);
  page.drawText(codeText, { x: (width - codeWidth) / 2, y: codeBoxY + 14, size: codeSize, font: helveticaBold, color: COLOR.navy });

  y = codeBoxY - 18;

  const descLines = [
    'Todos os assinantes verificaram sua identidade via dupla autenticacao (senha + facial biometrico).',
    'Use o codigo acima para validar este documento em: menin.office/verificar',
  ];
  for (const line of descLines) {
    page.drawText(sanitizePdfText(line), { x: margin, y, size: 7.5, font: helvetica, color: COLOR.gray, maxWidth: width - margin * 2 });
    y -= 13;
  }

  // ── Bordas decorativas ────────────────────────────────────────────────────
  page.drawRectangle({ x: 8, y: 8, width: width - 16, height: height - 16, borderColor: COLOR.navy, borderWidth: 1.5, opacity: 0, borderOpacity: 1 });
  page.drawRectangle({ x: 12, y: 12, width: width - 24, height: height - 24, borderColor: COLOR.blue, borderWidth: 0.4, opacity: 0, borderOpacity: 1 });

  // ── Rodapé ────────────────────────────────────────────────────────────────
  page.drawRectangle({ x: 0, y: 0, width, height: 28, color: COLOR.navy });
  page.drawRectangle({ x: 0, y: 28, width, height: 2, color: COLOR.blue });
  const ft  = sanitizePdfText('Menin Office | Assinatura Digital Conjunta com Autenticacao Biometrica');
  const ftw = helvetica.widthOfTextAtSize(ft, 7.5);
  page.drawText(ft, { x: (width - ftw) / 2, y: 9, size: 7.5, font: helvetica, color: COLOR.white });
}

// ── Função principal — multi-assinatura ──────────────────────────────────────
/**
 * Gera o PDF final selado para documentos com múltiplos assinantes.
 *
 * @param {object} opts
 * @param {string}   opts.documentUrl          URL do PDF original
 * @param {string}   opts.documentName
 * @param {string}   opts.documentHash
 * @param {string}   opts.verificationCode     Código final do documento
 * @param {Date}     opts.signedAtFinal
 * @param {Array}    opts.signers              [{ name, signedAt, verificationCode }]
 * @param {number}   opts.creatorId
 * @param {number}   opts.documentId
 * @returns {Promise<string|null>}
 */
export async function stampMultiSignedPdf(opts) {
  const { documentUrl, documentName, documentHash, verificationCode, signedAtFinal, signers, creatorId, documentId } = opts;
  if (!documentUrl) return null;

  try {
    const bytes   = await downloadPdfBytes(documentUrl);
    const pdfDoc  = await PDFDocument.load(bytes, { ignoreEncryption: true });

    await stampExistingPagesMulti(pdfDoc, { signerCount: signers.length, verificationCode, signedAtFinal });
    await addMultiSignerCertificatePage(pdfDoc, { documentName, documentHash, verificationCode, signedAtFinal, signers });

    const stampedBytes = await pdfDoc.save();
    const newUrl       = await uploadPdfBytes(stampedBytes, creatorId, `doc-${documentId}`);
    return newUrl;
  } catch (err) {
    console.error('[signaturePdfStamp] Falha ao selar PDF multi-assinatura:', err.message);
    return null;
  }
}

// ── Função principal ──────────────────────────────────────────────────────────
export async function stampSignedPdf(opts) {
  const {
    documentUrl,
    documentName,
    documentHash,
    signerName,
    signedAt,
    ipAddress,
    verificationCode,
    userId,
    signatureId,
  } = opts;

  if (!documentUrl) return null;

  try {
    const originalBytes = await downloadPdfBytes(documentUrl);
    const pdfDoc = await PDFDocument.load(originalBytes, { ignoreEncryption: true });

    await stampExistingPages(pdfDoc, { signerName, verificationCode, signedAt });

    await addCertificatePage(pdfDoc, {
      documentName,
      signerName,
      signedAt,
      ipAddress,
      verificationCode,
      documentHash,
    });

    const stampedBytes = await pdfDoc.save();
    const newUrl = await uploadPdfBytes(stampedBytes, userId, signatureId);

    return newUrl;
  } catch (err) {
    console.error('[signaturePdfStamp] Falha ao adicionar carimbo no PDF:', err.message);
    return null;
  }
}