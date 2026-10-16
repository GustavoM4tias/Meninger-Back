// scripts/fontesDump.js
//
// Só leitura. Mostra as fontes da ficha comercial do módulo do mês mais
// recente de cada empreendimento informado, para conferir contra o CV.
//   node scripts/fontesDump.js 41 34 37
import db from '../models/sequelize/index.js';
import { montarFontes } from '../services/comercial/fichaFontesService.js';

const ids = process.argv.slice(2).map(Number).filter(Boolean);
for (const id of ids) {
    const [mods] = await db.sequelize.query(`
        SELECT m.id, m.module_name, m.idetapa, m.price_table_ids, to_jsonb(m)->>'product_type_override' AS product_type_override
          FROM enterprise_condition_modules m
          JOIN enterprise_conditions c ON c.id = m.condition_id
         WHERE c.idempreendimento = :id
           AND c.reference_month = (SELECT max(reference_month) FROM enterprise_conditions WHERE idempreendimento = :id)
         ORDER BY m.sort_order, m.id
    `, { replacements: { id } });
    for (const m of mods) {
        const f = await montarFontes({ idempreendimento: id, modulo: m, semCache: true });
        const resumo = {
            empreendimento: f?.empreendimento?.nome, modulo: m.module_name, tipo: f?.tipo_produto?.chave,
            tabela: f?.tabela && `${f.tabela.nome} (${f.tabela.data_vigencia_de} a ${f.tabela.data_vigencia_ate}, ${f.tabela.unidades_etapa} un.)`,
            preco: f?.preco && { principal: f.preco.principal, faixas: f.preco.faixas.slice(0, 4), tipologias: f.preco.tipologias, m2: f.preco.m2_medio },
            condicao: f?.condicao && { ref: f.condicao.unidade.nome, venda: f.condicao.preco_venda, rp: f.condicao.fluxo.recurso_proprio_pct, linhas: f.condicao.fluxo.linhas.map((l) => `${l.rotulo} ${l.qtd}x ${l.valor} (${l.pct}%) ${l.primeiro_vencimento}`) },
            regra_cv: f?.regra_cv,
            avaliacao: f?.avaliacao,
            compradores: f?.compradores,
            estoque: f?.estoque?.resumo,
            reservas: f?.reservas_mes,
            obra: f?.obra,
        };
        console.log(JSON.stringify(resumo, null, 1));
    }
}
await db.sequelize.close();
