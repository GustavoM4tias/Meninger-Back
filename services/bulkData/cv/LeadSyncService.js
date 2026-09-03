// src/services/bulkData/cv/LeadSyncService.js
import apiCv from '../../../lib/apiCv.js';
import db from '../../../models/sequelize/index.js';
import { Op } from 'sequelize';
import crypto from 'crypto';

const { Lead } = db;
const LIMIT = 1000;
const ID_VENDA_REALIZADA = 6;  // ajuste conforme seu CRM
// Situação "Descartado" no CV. Medido em 03/09/2026 pelo `/cvio/lead?idlead=`:
// o CV devolve `situacao: { id: 3, nome: 'Descartado' }`.
const ID_DESCARTADO = 3;

// Lacunas de id: quantos ids abaixo do topo conhecido e quantos acima dele o
// delta reconsulta um a um (ver `fillGaps`).
const GAP_JANELA = parseInt(process.env.LEAD_CV_GAP_WINDOW || '2000', 10);
const GAP_MARGEM = parseInt(process.env.LEAD_CV_GAP_TAIL || '20', 10);

function hashObj(o) {
    return crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');
}

/**
 * Forma canônica de um valor, para COMPARAR (nunca para gravar).
 *
 * Duas armadilhas que faziam a comparação de lead sempre acusar mudança:
 *
 *   Datas - vêm como Date do banco e como texto do CV. O `toISOString` põe as
 *   duas no mesmo formato.
 *
 *   JSONB - o Postgres reordena as chaves ao gravar, então o `interacao` que
 *   volta do banco tem ordem diferente do que veio do CV, com o MESMO
 *   conteúdo. Um `JSON.stringify` direto é sensível à ordem e acusaria
 *   diferença em todo lead que já teve uma interação. Por isso as chaves são
 *   ordenadas antes de serializar.
 */
function canonico(valor) {
    const preparar = (v) => {
        if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
        if (v === undefined) return null;
        if (Array.isArray(v)) return v.map(preparar);
        if (v && typeof v === 'object') {
            return Object.keys(v).sort().reduce((acc, k) => { acc[k] = preparar(v[k]); return acc; }, {});
        }
        return v;
    };
    return JSON.stringify(preparar(valor));
}

async function fetchAll(url) {
    let offset = 0, all = [];
    console.log(`🔍 Iniciando fetch: ${url}`);
    while (true) {
        const res = await apiCv.get(`${url}&limit=${LIMIT}&offset=${offset}`);
        const data = res.data.leads;
 
        console.log(`   → Página offset=${offset} | retornados=${data.length}`);

        all.push(...data);
        if (data.length < LIMIT) break;
        offset += LIMIT;
    }
    console.log(`✅ Fim do fetch "${url}" — total=${all.length} leads\n`);
    return all;
}

export default class CvLeadSyncService {
    async loadAll() {
        console.log('🚀 Bulk inicial de Leads');
        const all = await fetchAll('/cvio/lead?');  // sem filtros
        await this.upsertBatch(all);
        console.log(`🎉 Bulk concluído: ${all.length} leads`);
    }

    async loadDelta() {
        console.log('🚀 Delta: ativos + vendidos');
        const [ativos, vendidos] = await Promise.all([
            fetchAll('/cvio/lead?ativo=true'),
            fetchAll(`/cvio/lead?idsituacao=${ID_VENDA_REALIZADA}`)
        ]);
        const merge = [...ativos, ...vendidos];
        const idsSync = merge.map(l => l.idlead);

        console.log(`📦 Leads ativos: ${ativos.length}`);
        console.log(`💰 Leads vendidos: ${vendidos.length}`);
        console.log(`🔄 Total a sincronizar: ${merge.length}`);

        await this.upsertBatch(merge);

        // Lead que sumiu da lista de ativos sem ter vendido foi descartado no
        // CV. O id da situação vai JUNTO com o nome: antes só o nome mudava e
        // 11.703 leads ficaram "Descartado" com o situacao_id da etapa anterior
        // (Em Atendimento, 1ª Tentativa...) - medido em 03/09/2026, o CV
        // confirmava id 3 em todos os conferidos.
        await Lead.update(
            { situacao_id: ID_DESCARTADO, situacao_nome: 'Descartado' },
            {
                where: {
                    idlead: { [Op.notIn]: idsSync },
                    situacao_id: { [Op.notIn]: [ID_DESCARTADO, ID_VENDA_REALIZADA] }
                }
            }
        );

        // Lead criado E descartado entre um delta e outro nunca aparece em
        // "ativos" nem em "vendidos": sem isto ele nao entrava nunca (35607 e
        // 35957 estavam assim em 03/09/2026). O webhook cobre o caminho normal;
        // esta e a rede.
        const lacunas = await this.fillGaps();

        console.log(`🎉 Delta concluído: ${merge.length} leads processados | lacunas: ${JSON.stringify(lacunas)}`);
    }

    /**
     * Ids de lead que faltam na sequência, consultados um a um no CV.
     *
     * Só a janela recente (GAP_JANELA abaixo do topo) e uma margem acima dele:
     * os buracos antigos são leads apagados de verdade (60 de 60 sondados em
     * 03/09/2026 deram "Lead não encontrado") e não valem a chamada. O CV
     * responde 400 "Lead não encontrado" para id inexistente - isso é
     * resposta, não falha, e o id segue como buraco até sair da janela.
     */
    async fillGaps({ janela = GAP_JANELA, margem = GAP_MARGEM } = {}) {
        const buracos = await db.sequelize.query(`
            WITH topo AS (SELECT COALESCE(MAX(idlead), 0) AS mx FROM leads)
            SELECT g.id
              FROM generate_series(GREATEST(1, (SELECT mx FROM topo) - :janela), (SELECT mx FROM topo) + :margem) AS g(id)
              LEFT JOIN leads l ON l.idlead = g.id
             WHERE l.idlead IS NULL
             ORDER BY g.id DESC`, {
            replacements: { janela, margem },
            type: db.Sequelize.QueryTypes.SELECT,
        });

        const stats = { buracos: buracos.length, criados: 0, inexistentes: 0, falhas: 0 };
        for (const { id } of buracos) {
            try {
                const r = await this.syncOne(Number(id));
                if (r?.nao_encontrado) stats.inexistentes++;
                else if (r?.created) stats.criados++;
            } catch (e) {
                const msg = e?.response?.data?.mensagem || '';
                if (e?.response?.status === 400 && /n[aã]o encontrado/i.test(msg)) stats.inexistentes++;
                else { stats.falhas++; console.warn(`[Leads][gap] id=${id} falhou: ${e?.response?.status || e.message}`); }
            }
        }
        if (stats.buracos) console.log(`🧩 [Leads] lacunas: ${JSON.stringify(stats)}`);
        return stats;
    }

    async upsertBatch(arr) {
        console.log(`✍️ Iniciando upsert em ${arr.length} leads`);
        const CHUNK = 100;
        for (let i = 0; i < arr.length; i += CHUNK) {
            const slice = arr.slice(i, i + CHUNK);
            await Promise.all(slice.map(raw => this.upsertOne(raw)));

            console.log(`   → progresso: ${i + slice.length}/${arr.length}`);
        }
    }

    async upsertOne(raw) {
        const data = {
            idlead: raw.idlead,
            gestor: raw.gestor,
            imobiliaria: raw.imobiliaria,
            corretor: raw.corretor,
            situacao_id: raw.situacao.id,
            situacao_nome: raw.situacao.nome,
            nome: raw.nome,
            email: raw.email,
            telefone: raw.telefone,
            score: raw.score,
            data_cad: raw.data_cad,
            midia_principal: raw.midia_principal,
            documento_tipo: raw.documento_tipo,
            documento: raw.documento,
            sexo: raw.sexo,
            renda_familiar: raw.renda_familiar,
            valor_negocio: raw.valor_negocio.replace(',', '.'),
            cep: raw.cep,
            endereco: raw.endereco,
            numero: raw.numero,
            bairro: raw.bairro,
            complemento: raw.complemento,
            estado: raw.estado,
            cidade: raw.cidade,
            profissao: raw.profissao,
            origem: raw.origem,
            data_reativacao: raw.data_reativacao,
            data_vencimento: raw.data_vencimento,
            ultima_data_conversao: raw.ultima_data_conversao,
            codigointerno: raw.codigointerno,
            valor_venda: raw.valor_venda?.replace(',', '.'),
            tags: raw.tags,
            empreendimento: raw.empreendimento,
            interacao: raw.interacao,
            autor_ultima_alteracao: raw.autor_ultima_alteracao,
            qtde_simulacoes_associadas: raw.qtde_simulacoes_associadas,
            qtde_reservas_associadas: raw.qtde_reservas_associadas,
            link_interacoes: raw.link_interacoes,
            link_simulacoes: raw.link_simulacoes,
            link_reservas: raw.link_reservas,
            link_interesses: raw.link_interesses,
            idrd_station: raw.idrd_station,
            link_rdstation: raw.link_rdstation,
            motivo_cancelamento: raw.motivo_cancelamento?.nome ?? null,
            submotivo_cancelamento: raw.submotivo_cancelamento?.nome ?? null,
        };

        const existing = await Lead.findByPk(data.idlead);
        if (!existing) {
            await Lead.create(data);
            return 'created';
        }

        // Se o raw não trouxe motivo mas o banco já tem, preserva
        if (!data.motivo_cancelamento && existing.motivo_cancelamento) {
            data.motivo_cancelamento = existing.motivo_cancelamento;
            data.submotivo_cancelamento = existing.submotivo_cancelamento;
        }

        // A comparação precisa ser entre os MESMOS campos E no MESMO formato.
        //
        // Antes era `hashObj(existing.toJSON())` contra `hashObj(data)`, e os
        // hashes nunca batiam por dois motivos somados: o primeiro traz todas
        // as colunas do model (created_at, updated_at, ordem de chaves do
        // Sequelize) e o segundo só o subconjunto mapeado; e mesmo campo a
        // campo os tipos diferem - `data_cad` é Date no banco e texto
        // "2026-08-31 15:52:18" no que vem do CV. Resultado medido em
        // 27/08/2026: 27.260 de 27.260 leads reescritos a cada rodada.
        //
        // `Lead.build` passa o payload pelas MESMAS regras de coerção que o
        // Sequelize usaria para gravar, então os dois lados chegam à comparação
        // no mesmo formato - inclusive as datas, sem depender do fuso do
        // processo, já que os dois são coagidos no mesmo lugar.
        const candidato = Lead.build(data, { isNewRecord: false });

        const mudou = Object.keys(data).some(campo =>
            canonico(existing.get(campo)) !== canonico(candidato.get(campo)));

        if (!mudou) return 'unchanged';
        await existing.update(data);
        return 'updated';
    }

    /**
     * Sincroniza UM lead pelo id. É o caminho do webhook.
     *
     * O filtro `idlead` da listagem é honrado de verdade (conferido em
     * 28/08/2026 com dois ids distintos, cada um devolvendo só o seu) - ao
     * contrário do `idreserva` do endpoint de repasses, que é ignorado em
     * silêncio. Por isso aqui dá para buscar direto, sem conferência extra.
     */
    async syncOne(idlead) {
        const id = Number(idlead);
        if (!Number.isFinite(id)) throw new Error('idlead inválido.');

        const { data } = await apiCv.get(`/cvio/lead?idlead=${id}&limit=1`);
        const raw = (data?.leads || []).find(l => Number(l?.idlead) === id);
        if (!raw) return { total: 0, nao_encontrado: true };

        const resultado = await this.upsertOne(raw);
        return {
            total: 1,
            created: resultado === 'created' ? 1 : 0,
            updated: resultado === 'updated' ? 1 : 0,
            unchanged: resultado === 'unchanged' ? 1 : 0,
        };
    }
}
