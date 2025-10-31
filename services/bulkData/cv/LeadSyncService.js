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
            link_rdstation: raw.link_rdstation
        };

        const existing = await Lead.findByPk(data.idlead);
        if (!existing) {
            await Lead.create(data);
        } else {
            // compara hash para evitar update desnecessário
            const oldHash = hashObj(existing.toJSON());
            const newHash = hashObj(data);
            if (oldHash !== newHash) {
                await existing.update(data);
            }
        }
    }
}
