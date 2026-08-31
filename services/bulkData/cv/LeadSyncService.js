// src/services/bulkData/cv/LeadSyncService.js
import apiCv from '../../../lib/apiCv.js';
import db from '../../../models/sequelize/index.js';
import { Op } from 'sequelize';
import crypto from 'crypto';

const { Lead } = db;
const LIMIT = 1000;
const ID_VENDA_REALIZADA = 6;  // ajuste conforme seu CRM

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

        // marca descartados
        await Lead.update(
            { situacao_nome: 'Descartado' },
            {
                where: {
                    idlead: { [Op.notIn]: idsSync },
                    situacao_id: { [Op.notIn]: [3, ID_VENDA_REALIZADA] }
                }
            }
        );
 
        console.log(`🎉 Delta concluído: ${merge.length} leads processados`);
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
