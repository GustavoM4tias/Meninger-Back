// /src/services/bulkData/cv/EnterpriseSyncController.js
import apiCv from '../../../lib/apiCv.js';
import db from '../../../models/sequelize/index.js';
import crypto from 'crypto';

const {
    CvEnterprise, CvEnterpriseStage, CvEnterpriseBlock, CvEnterpriseUnit,
    CvEnterpriseMaterial, CvEnterprisePlan
} = db;

function sha(o) {
    return crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');
}

// -------- FETCHERS (ajuste URL se seu apiCv usa prefixos diferentes) ----------
async function fetchList() {
    // lista: igual seu exemplo /cvio/empreendimento
    const res = await apiCv.get('/cvio/empreendimento');
    return Array.isArray(res.data) ? res.data : [];
}

async function fetchDetail(id) {
    const res = await apiCv.get(`/cvio/empreendimento/${id}`);
    return res.data;
}

function parseVagasQtde(v) {
    if (v == null) return null;
    const m = String(v).match(/\b(\d+)\b/); // pega o primeiro número da frase
    return m ? parseInt(m[1], 10) : null;
}

// --------- MAPPERS ------------------------------------------------------------
function pickListFields(raw) {
    // campos da listagem que o front usa nos cards/filtros
    const sc = raw?.situacao_comercial?.[0]?.nome || null;
    const so = raw?.situacao_obra?.[0]?.nome || null;
    const te = raw?.tipo_empreendimento?.[0]?.nome || null;
    const sg = raw?.segmento?.[0]?.nome || null;

    return {
        idempreendimento: raw.idempreendimento ?? raw.id,
        idempreendimento_int: raw.idempreendimento_int ?? null,

        nome: raw.nome,
        regiao: raw.regiao ?? null,
        cidade: raw.cidade ?? null,
        estado: raw.estado ?? null,
        sigla: raw.sigla ?? null,

        bairro: raw.bairro ?? null,
        endereco_emp: raw.endereco_emp ?? null,
        numero: raw.numero ?? null,
        logradouro: raw.logradouro ?? null,
        cep: raw.cep ?? null,
        endereco: raw.endereco ?? null,

        idempresa: raw.idempresa ?? null,

        logo: raw.logo ?? null,
        foto_listagem: raw.foto_listagem ?? null,
        foto: raw.foto ?? null,

        app_exibir: raw.app_exibir ?? null,
        app_cor_background: raw.app_cor_background ?? null,

        data_entrega: raw.data_entrega ?? null,

        andamento: raw.andamento ?? null,
        unidades_disponiveis: raw.unidades_disponiveis ?? null,

        situacao_comercial_nome: sc,
        situacao_obra_nome: so,
        tipo_empreendimento_nome: te,
        segmento_nome: sg,

        raw
    };
}

function pickDetailFields(raw) {
    const base = pickListFields(raw);

    // detalhe: empresa, matrícula, localização detalhada, tabela, lat/lon, etc.
    return {
        ...base,

        matricula: raw.matricula ?? null,
        nome_empresa: raw.nome_empresa ?? null,
        razao_social_empesa: raw.razao_social_empesa ?? null,
        cnpj_empesa: raw.cnpj_empesa ?? null,
        endereco_empresa: raw.endereco_empresa ?? null,

        latitude: raw.latitude ? Number(String(raw.latitude).replace(',', '.')) : null,
        longitude: raw.longitude ? Number(String(raw.longitude).replace(',', '.')) : null,

        periodo_venda_inicio: raw.periodo_venda_inicio ?? null,
        titulo: raw.titulo ?? null,
        descricao: raw.descricao ?? null,

        tabela: raw.tabela ?? null,

        raw
    };
}

// --------- UPSERTS ------------------------------------------------------------
async function upsertEnterpriseFromList(item) {
    const id = item.idempreendimento ?? item.id;
    if (!id) return;

    const mapped = pickListFields(item);
    const h = sha(item);

    const existing = await CvEnterprise.findByPk(id);
    const data = {
        ...mapped,
        content_hash: h,
        cv_created_at: item?.criado_em ? new Date(item.criado_em) : null,
        cv_updated_at: item?.atualizado_em ? new Date(item.atualizado_em) : null,
    };

    if (!existing) await CvEnterprise.create(data);
    else if (existing.content_hash !== h) await existing.update(data);
}

async function upsertEnterpriseFromDetail(detail) {
    const id = detail.idempreendimento ?? detail.id;
    if (!id) return;
    const mapped = pickDetailFields(detail);
    const h = sha(detail);

    const existing = await CvEnterprise.findByPk(id);
    const data = {
        ...mapped,
        content_hash: h,
        cv_created_at: detail?.criado_em ? new Date(detail.criado_em) : null,
        cv_updated_at: detail?.atualizado_em ? new Date(detail.atualizado_em) : null,
    };

    if (!existing) await CvEnterprise.create(data);
    else if (existing.content_hash !== h) await existing.update(data);
}

async function replaceChildren(detail) {
    const id = detail.idempreendimento ?? detail.id;
    if (!id) return;

    await Promise.all([
        CvEnterpriseMaterial.destroy({ where: { idempreendimento: id } }),
        CvEnterprisePlan.destroy({ where: { idempreendimento: id } }),
        CvEnterpriseStage.destroy({ where: { idempreendimento: id } }),
    ]);

    // materiais
    if (Array.isArray(detail.materiais_campanha)) {
        await CvEnterpriseMaterial.bulkCreate(
            detail.materiais_campanha.map(m => ({
                idarquivo: m.idarquivo,
                idempreendimento: id,
                nome: m.nome ?? null,
                tipo: m.tipo ?? null,
                tamanho: m.tamanho ?? null,
                arquivo: m.arquivo ?? null,
                servidor: m.servidor ?? null,
                raw: m
            })),
            { ignoreDuplicates: true }
        );
    }

    // plantas mapeadas (com pontos embutidos no raw)
    if (Array.isArray(detail.plantas_mapeadas)) {
        await CvEnterprisePlan.bulkCreate(
            detail.plantas_mapeadas.map(p => ({
                idplanta_mapeada: p.idplanta_mapeada,
                idempreendimento: id,
                nome: p.nome ?? null,
                link: p.link ?? null,
                raw: p // inclui pontos
            })),
            { ignoreDuplicates: true }
        );
    }

    // etapas/blocos/unidades
    if (Array.isArray(detail.etapas)) {
        for (const e of detail.etapas) {
            await CvEnterpriseStage.create({
                idetapa: e.idetapa,
                idetapa_int: e.idetapa_int ?? null,
                idempreendimento: id,
                nome: e.nome ?? null,
                data_cad: e.data_cad ?? null,
                raw: e
            });

            if (Array.isArray(e.blocos)) {
                for (const b of e.blocos) {
                    // paginacao
                    const p = b?.paginacao_unidade || {};
                    await CvEnterpriseBlock.create({
                        idbloco: b.idbloco,
                        idbloco_int: b.idbloco_int ?? null,
                        idetapa: e.idetapa,
                        nome: b.nome ?? null,
                        data_cad: b.data_cad ?? null,
                        total_unidades: p.total ?? 0,
                        limite_dados_unidade: p.limite_dados_unidade ?? null,
                        pagina_unidade: p.pagina_unidade ?? null,
                        paginas_total: p.paginas_total ?? null,
                        raw: b
                    });

                    if (Array.isArray(b.unidades)) {
                        const units = b.unidades.map(u => ({
                            idunidade: u.idunidade,
                            idunidade_int: u.idunidade_int ?? null,
                            idbloco: b.idbloco,

                            nome: u.nome,
                            area_privativa: u.area_privativa ? Number(String(u.area_privativa).replace(',', '.')) : null,
                            area_comum: u.area_comum ? Number(String(u.area_comum).replace(',', '.')) : null,
                            valor: u.valor ? Number(String(u.valor).replace(',', '.')) : null,
                            valor_avaliacao: u.valor_avaliacao ? Number(String(u.valor_avaliacao).replace(',', '.')) : null,
                            vagas_garagem: u.vagas_garagem ?? null,
                            vagas_garagem_qtde: parseVagasQtde(u.vagas_garagem),
                            andar: u.andar ?? null,
                            coluna: u.coluna ?? null,
                            posicao: u.posicao ?? null,
                            tipologia: u.tipologia ?? null,
                            tipo: u.tipo ?? null,
                            idtipo_int: u.idtipo_int ?? null,

                            situacao_mapa_disponibilidade: u?.situacao?.situacao_mapa_disponibilidade ?? null,

                            data_bloqueio: u.data_bloqueio ?? null,
                            data_entrega: u.data_entrega ?? null,
                            data_entrega_chaves: u.data_entrega_chaves ?? null,
                            agendar_a_partir: u.agendar_a_partir ?? null,
                            liberar_a_partir: u.liberar_a_partir ?? null,

                            raw: u
                        }));

                        const CHUNK = 1000;
                        for (let i = 0; i < units.length; i += CHUNK) {
                            await CvEnterpriseUnit.bulkCreate(units.slice(i, i + CHUNK), { ignoreDuplicates: true });
                        }
                    }
                }
            }
        }
    }
}

// --------- SERVICE API --------------------------------------------------------
export default class EnterpriseSyncController {
    async loadAll() {
        console.log('🏢 [Empreendimentos] FULL sync: lista');
        const list = await fetchList();

        let i = 0;
        for (const item of list) {
            await upsertEnterpriseFromList(item);
            if (++i % 100 === 0) console.log(`   → lista ${i}/${list.length}`);
        }
        console.log('🏗️  [Empreendimentos] FULL: detalhes + filhos');
        i = 0;
        for (const item of list) {
            const id = item.idempreendimento ?? item.id;
            try {
                const detail = await fetchDetail(id);
                await upsertEnterpriseFromDetail(detail);
                await replaceChildren(detail);
                if (++i % 20 === 0) console.log(`   → detalhes ${i}/${list.length}`);
            } catch (err) {
                console.error(`   × detalhe ${id}:`, err?.message || err);
            }
        }
        console.log('✅ [Empreendimentos] FULL concluído');
    }

    async loadDelta() {
        console.log('🏢 [Empreendimentos] DELTA');
        const list = await fetchList();
        const toDetail = [];

        for (const item of list) {
            const id = item.idempreendimento ?? item.id;
            const h = sha(item);
            const existing = await CvEnterprise.findByPk(id);
            if (!existing || existing.content_hash !== h) {
                await upsertEnterpriseFromList(item);
                toDetail.push(id);
            }
        }

        let ok = 0;
        for (const id of toDetail) {
            try {
                const detail = await fetchDetail(id);
                await upsertEnterpriseFromDetail(detail);
                await replaceChildren(detail);
                ok++;
            } catch (err) {
                console.error(`   × delta detalhe ${id}:`, err?.message || err);
            }
        }
        console.log(`✅ [Empreendimentos] DELTA concluído: ${ok} atualizados`);
    }
}
