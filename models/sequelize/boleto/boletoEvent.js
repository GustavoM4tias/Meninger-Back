// models/sequelize/boleto/boletoEvent.js
//
// Eventos cronológicos do ciclo de vida de um boleto. Append-only —
// nenhuma row é editada ou apagada, só inserida. Permite reconstruir
// timeline completa pra UI sem precisar inferir de campos do history.
//
// Tipos previstos (não-exaustivo):
//   emitted           Boleto criado no Ecobrança
//   pdf_saved         PDF salvo no Supabase
//   cv_attached       Documento anexado na reserva CV
//   cv_attach_failed  Anexo no CV falhou (com motivo no message)
//   client_email      Email enviado ao titular
//   client_whatsapp   WhatsApp enviado ao titular
//   cv_message_sent   Mensagem postada na timeline do CV
//   cv_situation      Situação CV alterada
//   payment_check     Scheduler consultou o status no Ecobrança
//   paid              Detectado como LIQUIDADO
//   baixa_requested   Baixa por devolução iniciada
//   baixa_confirmed   Baixa confirmada pelo Ecobrança
//   baixa_failed      Baixa falhou (com motivo no message)
//   error             Erro genérico

export default (sequelize, DataTypes) => {
    const BoletoEvent = sequelize.define('BoletoEvent', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

        boleto_history_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
            comment: 'FK lógica pra boleto_history.id (sem constraint pra simplificar deletes).',
        },
        idreserva: {
            type: DataTypes.INTEGER,
            allowNull: false,
            comment: 'Duplicado pra facilitar query por reserva sem join.',
        },
        type: {
            type: DataTypes.STRING(40),
            allowNull: false,
            comment: 'Tipo do evento (ver header do arquivo pra lista canônica).',
        },
        severity: {
            type: DataTypes.STRING(10),
            defaultValue: 'info',
            comment: 'info | warning | error | success',
        },
        message: {
            type: DataTypes.TEXT,
            allowNull: true,
            comment: 'Mensagem humana de descrição. Pode ter mais detalhes em data.',
        },
        data: {
            type: DataTypes.TEXT,
            allowNull: true,
            get() {
                const raw = this.getDataValue('data');
                if (!raw) return null;
                try { return JSON.parse(raw); } catch { return null; }
            },
            set(val) {
                if (val == null) { this.setDataValue('data', null); return; }
                this.setDataValue('data', JSON.stringify(val));
            },
            comment: 'JSON serializado com contexto (httpStatus, situacao, wamid, etc).',
        },
    }, {
        tableName: 'boleto_events',
        underscored: true,
        timestamps: true,
        updatedAt: false, // append-only
        indexes: [
            { fields: ['boleto_history_id'] },
            { fields: ['idreserva'] },
            { fields: ['type'] },
        ],
    });

    BoletoEvent.associate = () => {};
    return BoletoEvent;
};
