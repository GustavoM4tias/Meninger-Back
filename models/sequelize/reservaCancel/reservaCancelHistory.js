// models/sequelize/reservaCancel/reservaCancelHistory.js
//
// Registro de cada cancelamento de reserva processado pela automação
// CV × Sienge. Um webhook (ou reprocessamento manual) = 1 linha.
//
// `status` (STRING deliberadamente — sync({ alter: true }) falha silenciosamente
// em tabelas com ENUM, ver boleto_history):
//   processing = em andamento
//   success    = fluxo concluído (contrato excluído e/ou unidade disponibilizada)
//   blocked    = validação barrou — NADA foi alterado; pendência p/ tratamento manual
//   skipped    = fluxo não se aplica (reserva não cancelada, automação desativada)
//   ignored    = webhook duplicado — já havia processamento/sucesso p/ a reserva
//   error      = falha técnica (API fora, delete não confirmado, etc.)
export default (sequelize, DataTypes) => {
    const jsonText = (field) => ({
        type: DataTypes.TEXT,
        allowNull: true,
        get() {
            const raw = this.getDataValue(field);
            if (!raw) return null;
            try { return JSON.parse(raw); } catch { return null; }
        },
        set(val) {
            if (val == null) { this.setDataValue(field, null); return; }
            this.setDataValue(field, JSON.stringify(val));
        },
    });

    const ReservaCancelHistory = sequelize.define('ReservaCancelHistory', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

        // ── Identificação da reserva (CV) ─────────────────────────────────────
        idreserva: { type: DataTypes.INTEGER, allowNull: false },
        titular_nome: { type: DataTypes.STRING, allowNull: true },
        titular_documento: { type: DataTypes.STRING(20), allowNull: true },
        empreendimento: { type: DataTypes.STRING, allowNull: true },
        idempreendimento_cv: { type: DataTypes.INTEGER, allowNull: true },
        unidade_nome: { type: DataTypes.STRING, allowNull: true },
        idunidade_cv: { type: DataTypes.INTEGER, allowNull: true },
        idunidade_int: {
            type: DataTypes.STRING(20),
            allowNull: true,
            comment: 'Código interno da unidade no CV = ID da unidade no Sienge.',
        },
        data_cancelamento: {
            type: DataTypes.STRING(30),
            allowNull: true,
            comment: 'data_cancelamento ou data_distrato da reserva no CV (como veio).',
        },
        motivo_cancelamento: { type: DataTypes.TEXT, allowNull: true },

        // ── Contrato localizado no Sienge ─────────────────────────────────────
        contrato_id: { type: DataTypes.INTEGER, allowNull: true },
        contrato_numero: { type: DataTypes.STRING(60), allowNull: true },
        contrato_situacao: { type: DataTypes.STRING(30), allowNull: true },
        contrato_valor: { type: DataTypes.DECIMAL(15, 2), allowNull: true },

        // ── Resultado ─────────────────────────────────────────────────────────
        status: {
            type: DataTypes.STRING(20),
            allowNull: false,
            defaultValue: 'processing',
            comment: 'processing | success | blocked | skipped | ignored | error',
        },
        motivo: {
            type: DataTypes.TEXT,
            allowNull: true,
            comment: 'Explicação humana do bloqueio/skip/erro (null em sucesso).',
        },

        // ── Ações efetivamente executadas ─────────────────────────────────────
        sienge_contrato_excluido: { type: DataTypes.BOOLEAN, defaultValue: false, allowNull: false },
        cv_unidade_disponibilizada: { type: DataTypes.BOOLEAN, defaultValue: false, allowNull: false },
        cv_mensagem_enviada: { type: DataTypes.BOOLEAN, defaultValue: false, allowNull: false },
        cv_situacao_alterada: { type: DataTypes.BOOLEAN, defaultValue: false, allowNull: false },
        situacao_aplicada_id: {
            type: DataTypes.INTEGER,
            allowNull: true,
            comment: 'Etapa CV aplicada pela automação (Pendência no bloqueio/erro, Cancelada no sucesso).',
        },

        // ── Auditoria ─────────────────────────────────────────────────────────
        manual: {
            type: DataTypes.BOOLEAN,
            defaultValue: false,
            allowNull: false,
            comment: 'True quando disparado por admin (reprocessar/processar manual).',
        },
        triggered_by: { type: DataTypes.INTEGER, allowNull: true, comment: 'user.id do admin no disparo manual.' },
        webhook_payload: { ...jsonText('webhook_payload'), comment: 'Corpo bruto recebido no webhook (auditoria).' },
        checks: { ...jsonText('checks'), comment: 'Snapshot das validações: [{ check, ok, detalhe }].' },
        warnings: { ...jsonText('warnings'), comment: 'Falhas não-fatais: [{ etapa, erro }].' },
    }, {
        tableName: 'reserva_cancel_history',
        underscored: true,
        timestamps: true,
        indexes: [
            { fields: ['idreserva'] },
            { fields: ['status'] },
        ],
    });

    ReservaCancelHistory.associate = () => {};
    return ReservaCancelHistory;
};
