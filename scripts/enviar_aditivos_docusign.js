// scripts/enviar_aditivos_docusign.js
//
// Cria os envelopes DocuSign dos aditivos da cláusula 13 e devolve o link
// público de assinatura de cada signatário.
//
// Os destinatários são CAPTIVE (clientUserId): o DocuSign NÃO dispara e-mail
// nenhum. Quem avisa o cliente é a gente, mandando o link /assinar/<token> —
// que é fixo e gera na hora a URL de assinatura (a do DocuSign vive minutos).
//
//   node scripts/enviar_aditivos_docusign.js                 # simulação (não cria nada)
//   node scripts/enviar_aditivos_docusign.js --enviar        # cria os envelopes de verdade
//   node scripts/enviar_aditivos_docusign.js --links         # só lista os links já criados
//   node scripts/enviar_aditivos_docusign.js --enviar --so "BL A - AP 125"
//
// Idempotente: unidade que já tem envelope ativo é pulada.
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import db from '../models/sequelize/index.js';
import Docusign from '../services/comercial/DocusignService.js';
import { basePublica, linkPublico } from '../controllers/aditivos/assinaturaPublicaController.js';

const { AditivoSignature } = db;

const PASTA = process.env.ADITIVOS_DIR
    || 'C:/Users/Menin/OneDrive - MENIN/Documentos/Github/Meninger/Aditivos/Parque das Flores/_docusign';
const MANIFESTO = path.join(PASTA, '_manifesto_envio.json');

const args = process.argv.slice(2);
const ENVIAR = args.includes('--enviar');
const SO_LINKS = args.includes('--links');
const FILTRO = (() => {
    const i = args.indexOf('--so');
    return i >= 0 ? args[i + 1] : null;
})();

const linkDe = linkPublico;
// Base62 (sem - e _): a rota da LP casa o token na raiz por esse formato, e
// assim ele nunca se confunde com um slug de landing page (que é kebab-case).
const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const novoToken = () => Array.from(crypto.randomBytes(22))
    .map((b) => ALFABETO[b % ALFABETO.length])
    .join('');
const baseEhLocal = () => /\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/i.test(basePublica());

async function listarLinks() {
    const linhas = await AditivoSignature.findAll({ order: [['unidade', 'ASC']] });
    if (!linhas.length) return console.log('Nenhum envelope criado ainda.');
    for (const l of linhas) {
        console.log(`\n${l.unidade}  [${l.status}]  envelope ${l.envelope_id ?? '-'}`);
        for (const s of l.signers ?? []) {
            console.log(`  ${s.papel.padEnd(9)} ${s.nome}`);
            console.log(`  ${''.padEnd(9)} ${linkDe(s.token)}   (${s.status ?? 'pendente'})`);
        }
    }
    console.log(`\n${linhas.length} envelopes | ${linhas.reduce((n, l) => n + (l.signers?.length ?? 0), 0)} links`);
}

async function main() {
    if (SO_LINKS) { await listarLinks(); return; }

    // O token vai gravado com o link; se a base estiver errada na hora de criar,
    // os 32 links nascem quebrados. Trava antes de gastar envelope.
    if (ENVIAR && baseEhLocal()) {
        throw new Error(`A base pública do link está em ${basePublica()} — o cliente não alcança. `
            + 'Defina ADITIVO_LINK_BASE (ou PUBLIC_BACKEND_URL) com a URL pública do backend antes de enviar.');
    }

    const manifesto = JSON.parse(fs.readFileSync(MANIFESTO, 'utf8'));
    const alvo = FILTRO ? manifesto.filter((m) => m.unidade === FILTRO) : manifesto;
    if (!alvo.length) throw new Error(`Nada a enviar (filtro "${FILTRO}" não bateu com nenhuma unidade).`);

    if (!ENVIAR) {
        console.log('=== SIMULAÇÃO — nada será criado. Use --enviar para valer. ===\n');
    } else if (!(await Docusign.isConfigured())) {
        throw new Error('DocuSign não está conectado. Abra Configurações → DocuSign e clique em "Conectar com DocuSign".');
    }

    let criados = 0, pulados = 0, erros = 0;

    for (const item of alvo) {
        const jaExiste = await AditivoSignature.findOne({
            where: { reserva_id: item.idreserva },
            order: [['id', 'DESC']],
        });
        if (jaExiste && !['voided', 'error'].includes(jaExiste.status)) {
            console.log(`- ${item.unidade}: já tem envelope (${jaExiste.status}) — pulando.`);
            pulados++;
            continue;
        }

        const arquivo = path.join(PASTA, item.arquivo);
        if (!fs.existsSync(arquivo)) {
            console.error(`! ${item.unidade}: PDF não encontrado (${item.arquivo})`);
            erros++;
            continue;
        }

        const signers = item.signatarios.map((s, i) => ({
            name: s.nome,
            email: s.email,
            order: 1,                                   // paralelo: todos ao mesmo tempo
            clientUserId: `res-${item.idreserva}-${i + 1}`,
        }));

        console.log(`${ENVIAR ? '>' : '·'} ${item.unidade}: ${signers.length} assinante(s) — ${signers.map((s) => s.name).join(', ')}`);
        if (!ENVIAR) { criados++; continue; }

        try {
            const { envelopeId } = await Docusign.createEnvelope({
                subject: item.assunto,
                signers,
                placement: 'final',                     // usa as âncoras /sigN/ e /dtN/ do PDF
                documents: [{
                    base64: fs.readFileSync(arquivo).toString('base64'),
                    name: item.arquivo,
                    extension: 'pdf',
                }],
            });

            const linha = await AditivoSignature.create({
                reserva_id: item.idreserva,
                empreendimento: item.empreendimento,
                unidade: item.unidade,
                arquivo: item.arquivo,
                envelope_id: envelopeId,
                status: 'sent',
                subject: item.assunto,
                sent_at: new Date(),
                signers: item.signatarios.map((s, i) => ({
                    nome: s.nome,
                    email: s.email,
                    cpf: s.cpf,
                    papel: s.papel,
                    client_user_id: `res-${item.idreserva}-${i + 1}`,
                    token: novoToken(),
                    status: 'pendente',
                    clicks: 0,
                })),
            });

            criados++;
            for (const s of linha.signers) console.log(`    ${s.nome}: ${linkDe(s.token)}`);
        } catch (e) {
            erros++;
            console.error(`! ${item.unidade}: ${e.message}`);
            await AditivoSignature.create({
                reserva_id: item.idreserva, empreendimento: item.empreendimento, unidade: item.unidade,
                arquivo: item.arquivo, status: 'error', subject: item.assunto, error: e.message,
            }).catch(() => {});
        }
    }

    console.log(`\n${ENVIAR ? 'Criados' : 'Seriam criados'}: ${criados} | pulados: ${pulados} | erros: ${erros}`);
    if (!ENVIAR) console.log('Rode de novo com --enviar quando quiser criar os envelopes.');
}

main()
    .then(() => process.exit(0))
    .catch((e) => { console.error(e.message); process.exit(1); });
