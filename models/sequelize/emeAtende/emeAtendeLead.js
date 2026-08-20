// models/sequelize/emeAtende/emeAtendeLead.js
//
// Lead recebido pela Eme Atende (via API, tap do marketing ou contato frio inbound).
// Futuro: vincular ao lead do CV (cv_lead_id) pra mover etapas do funil.

import { Model } from 'sequelize';

export default (sequelize, DataTypes) => {
    class EmeAtendeLead extends Model {}

    EmeAtendeLead.init({
        name: { type: DataTypes.STRING(180), allowNull: true },
        phone: { type: DataTypes.STRING(20), allowNull: false }, // normalizado 55DDD...
        email: { type: DataTypes.STRING(180), allowNull: true },
        source: { type: DataTypes.STRING(60), allowNull: true },   // meta|site|cv|manual|whatsapp_inbound...
        campaign: { type: DataTypes.STRING(180), allowNull: true },
        empreendimento: { type: DataTypes.STRING(180), allowNull: true },
        external_id: { type: DataTypes.STRING(80), allowNull: true }, // id no sistema de origem
        // futuro: reconciliação com o CRM pra Eme Atende mover etapa do lead
        cv_lead_id: { type: DataTypes.STRING(40), allowNull: true },
        payload: { type: DataTypes.JSONB, allowNull: true, defaultValue: {} },
        // received|opened|engaged|qualified|closed|opted_out
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'received' },
        qualified_summary: { type: DataTypes.TEXT, allowNull: true },

        // ── Gestão do lead (ver emeAtendeLeadScoring.js) ─────────────────────
        // O que o lead DECLAROU na conversa. A IA preenche; ela não julga.
        // { momento_compra, finalidade, aprovacao_credito, restricao_nome,
        //   possui_imovel, entrada_disponivel, usa_fgts, renda_declarada,
        //   objecao_principal, observacao }
        qualificacao: { type: DataTypes.JSONB, allowNull: true, defaultValue: {} },
        // Derivados, calculados em código a partir da qualificação + comportamento.
        // Ficam gravados (e não só calculados na leitura) pra dar pra filtrar,
        // ordenar e ver a evolução no tempo.
        score: { type: DataTypes.INTEGER, allowNull: true },
        temperatura: { type: DataTypes.STRING(10), allowNull: true },   // quente|morno|frio|gelado
        chance_venda: { type: DataTypes.STRING(12), allowNull: true },  // alta|media|baixa|muito_baixa|nula
        // Etapa do funil que a Eme enxerga (o resto é do consultor).
        estagio: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'novo' },
        // Perda + política de volta: motivo é o que separa "perdido" de
        // "perdido para sempre".
        motivo_perda: { type: DataTypes.STRING(30), allowNull: true },
        reconversao: { type: DataTypes.STRING(10), allowNull: true },   // alta|media|baixa|nula
        recontatar_em: { type: DataTypes.DATE, allowNull: true },
        ultima_interacao_em: { type: DataTypes.DATE, allowNull: true },
        qualificado_em: { type: DataTypes.DATE, allowNull: true },
        perdido_em: { type: DataTypes.DATE, allowNull: true },
        flow_id: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        sequelize,
        modelName: 'EmeAtendeLead',
        tableName: 'eme_atende_leads',
        underscored: true,
        timestamps: true,
        indexes: [{ fields: ['phone'] }, { fields: ['status'] }, { fields: ['temperatura'] }, { fields: ['estagio'] }],
    });

    return EmeAtendeLead;
};
