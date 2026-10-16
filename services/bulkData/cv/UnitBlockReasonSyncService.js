// services/bulkData/cv/UnitBlockReasonSyncService.js
//
// Lê o MOTIVO do bloqueio de cada unidade e o grava em cv_unit_block_reasons.
//
// Até 16/10/2026 isto lia a listagem do PAINEL do CV, e parou de funcionar em
// 23/09/2026: o login do painel ganhou CAPTCHA (Cloudflare Turnstile) e robô
// nenhum passa. A tabela ficou vazia e o estoque comercial passou a viver só da
// marcação manual. Medido em 01/10 e de novo em 16/10: a própria API do CV já
// devolve o motivo em cada unidade - `situacao.bloqueada` ('S'),
// `situacao.bloqueada_idmotivo` (3 = Estratégia Comercial, 4 = Administrada
// pelo SIENGE, 2 = Negociação de Terreno) e `situacao.bloqueada_motivo` (o
// nome). É o mesmo detalhe (/cvio/empreendimento/{id}) que o sync de
// empreendimentos já lê, com a chave de integração: sem painel, sem sessão.
//
// Falha barulhenta e sem apagar: se a API não responder para um
// empreendimento, a rodada dele é descartada com erro no log do job, e o Office
// continua com o último dado bom em vez de zerar o estoque comercial.

import db from '../../../models/sequelize/index.js';
import apiCv from '../../../lib/apiCv.js';

const { CvEnterprise, sequelize } = db;

// O CV responde 429 quando várias leituras batem juntas (os crons de :00 e :30).
// Uma pausa curta entre empreendimentos e uma segunda tentativa depois de
// esperar resolvem sem transformar isto num cliente com fila própria.
const PAUSA_ENTRE_EMPREENDIMENTOS_MS = 800;
const ESPERA_APOS_429_MS = 15_000;

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function buscarDetalhe(idempreendimento) {
    const url = `/cvio/empreendimento/${idempreendimento}?limite_dados_unidade=1000`;
    try {
        return (await apiCv.get(url)).data;
    } catch (err) {
        if (err?.response?.status !== 429) throw err;
        await esperar(ESPERA_APOS_429_MS);
        return (await apiCv.get(url)).data;
    }
}

/** Todas as unidades do detalhe, onde quer que estejam (etapas > blocos > unidades). */
function coletarUnidades(no, out = [], bloco = null) {
    if (!no || typeof no !== 'object') return out;
    if (Array.isArray(no)) {
        if (no.length && no[0] && typeof no[0] === 'object' && 'idunidade' in no[0]) {
            out.push(...no.map((u) => ({ ...u, _bloco: bloco })));
        } else no.forEach((x) => coletarUnidades(x, out, bloco));
        return out;
    }
    // O bloco é o objeto que carrega a lista `unidades`; a unidade não repete o nome dele.
    const blocoAqui = Array.isArray(no.unidades) && no.nome ? norm(no.nome) : bloco;
    for (const v of Object.values(no)) coletarUnidades(v, out, blocoAqui);
    return out;
}

/** Lê o empreendimento na API e devolve só as unidades bloqueadas, com o motivo. */
export async function lerEmpreendimento(idempreendimento) {
    const detalhe = await buscarDetalhe(idempreendimento);
    if (!detalhe || typeof detalhe !== 'object') {
        throw new Error(`o CV não devolveu o empreendimento ${idempreendimento}`);
    }

    return coletarUnidades(detalhe)
        // Bloqueada = mapa 4. O `bloqueada: 'S'` sozinho não basta: unidade
        // vendida (mapa 3) carrega a marca antiga do bloqueio, sem motivo - 72
        // assim só no Adhara em 16/10/2026. É a mesma conferência da contagem
        // em unitStockService (data_bloqueio fora de reservada/vendida).
        .filter((u) => {
            const s = u?.situacao || {};
            const mapa = Number(s.situacao_mapa_disponibilidade);
            if (mapa === 4) return true;
            return String(s.bloqueada || '').toUpperCase() === 'S' && ![2, 3, 5].includes(mapa);
        })
        .map((u) => ({
            idunidade: Number(u.idunidade),
            unidade: norm(u.nome) || null,
            bloco: u._bloco || null,
            situacao: 'Bloqueada',
            motivo: norm(u.situacao?.bloqueada_motivo) || null,
            descricao: null,
        }))
        .filter((l) => Number.isFinite(l.idunidade) && l.idunidade > 0);
}

/**
 * Grava o que foi lido. Só as BLOQUEADAS entram na tabela: unidade que saiu do
 * bloqueio some daqui (o motivo dela deixou de existir), e o estado de venda
 * continua sendo assunto de cv_enterprise_units.
 */
async function gravar(idempreendimento, linhas) {
    const bloqueadas = linhas.filter((l) => /bloque/i.test(l.situacao || ''));

    await sequelize.transaction(async (t) => {
        if (bloqueadas.length) {
            const valores = bloqueadas.map((_, i) =>
                `(:id${i}, :emp${i}, :un${i}, :bl${i}, :sit${i}, :mot${i}, :desc${i}, NOW(), NOW(), NOW())`).join(',');

            const replacements = { };
            bloqueadas.forEach((l, i) => {
                replacements[`id${i}`] = l.idunidade;
                replacements[`emp${i}`] = idempreendimento;
                replacements[`un${i}`] = l.unidade;
                replacements[`bl${i}`] = l.bloco;
                replacements[`sit${i}`] = l.situacao;
                replacements[`mot${i}`] = l.motivo || null;
                replacements[`desc${i}`] = l.descricao || null;
            });

            await sequelize.query(
                `INSERT INTO cv_unit_block_reasons
                   (idunidade, idempreendimento, unidade, bloco, situacao, motivo, descricao, lido_em, created_at, updated_at)
                 VALUES ${valores}
                 ON CONFLICT (idunidade) DO UPDATE SET
                   idempreendimento = EXCLUDED.idempreendimento,
                   unidade   = EXCLUDED.unidade,
                   bloco     = EXCLUDED.bloco,
                   situacao  = EXCLUDED.situacao,
                   motivo    = EXCLUDED.motivo,
                   descricao = EXCLUDED.descricao,
                   lido_em   = NOW(),
                   updated_at = NOW()`,
                { replacements, transaction: t },
            );
        }

        const ids = bloqueadas.map((l) => l.idunidade);
        await sequelize.query(
            ids.length
                ? `DELETE FROM cv_unit_block_reasons
                    WHERE idempreendimento = :emp AND idunidade NOT IN (:ids)`
                : `DELETE FROM cv_unit_block_reasons WHERE idempreendimento = :emp`,
            { replacements: ids.length ? { emp: idempreendimento, ids } : { emp: idempreendimento }, transaction: t },
        );

        // Motivo novo que o CV passou a oferecer entra na tabela de regras como
        // "não conta" — aparece na tela para alguém decidir, em vez de sumir.
        const motivos = [...new Set(bloqueadas.map((l) => l.motivo).filter(Boolean))];
        for (const motivo of motivos) {
            await sequelize.query(
                `INSERT INTO cv_block_reason_rules (motivo, conta_estoque, descricao)
                 VALUES (:motivo, false, 'Motivo novo, lido do CV. Decida se conta como estoque comercial.')
                 ON CONFLICT (motivo) DO NOTHING`,
                { replacements: { motivo }, transaction: t },
            );
        }
    });

    return bloqueadas.length;
}

export default class UnitBlockReasonSyncService {
    /** Um empreendimento. Devolve quantas bloqueadas ficaram gravadas. */
    async syncForEnterprise(idempreendimento) {
        const linhas = await lerEmpreendimento(idempreendimento);
        return gravar(idempreendimento, linhas);
    }

    /** Todos os empreendimentos que o Office conhece. */
    async syncAll() {
        const emps = await CvEnterprise.findAll({
            attributes: ['idempreendimento', 'nome'],
            order: [['idempreendimento', 'ASC']],
        });

        let ok = 0; let falhas = 0; let total = 0;
        for (const [i, e] of emps.entries()) {
            if (i) await esperar(PAUSA_ENTRE_EMPREENDIMENTOS_MS);
            try {
                total += await this.syncForEnterprise(e.idempreendimento);
                ok++;
            } catch (err) {
                falhas++;
                console.error(`   × motivo de bloqueio ${e.idempreendimento} (${e.nome}):`, err?.message || err);
            }
        }

        console.log(`✅ [Motivos de bloqueio] ${ok} empreendimentos, ${total} unidades bloqueadas, ${falhas} falha(s)`);

        // Falha em TODOS é problema de credencial/API, não de um cadastro:
        // estourar aqui faz o job aparecer vermelho na tela em vez de "ok".
        if (ok === 0 && emps.length) {
            throw new Error('nenhum empreendimento pôde ser lido do CV (confira a chave de integração em CV CRM > Configurações)');
        }
        return { empreendimentos: ok, unidades: total, falhas };
    }
}
