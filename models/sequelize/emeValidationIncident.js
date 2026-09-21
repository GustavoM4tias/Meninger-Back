export default (sequelize, DataTypes) => {
  const EmeValidationIncident = sequelize.define('EmeValidationIncident', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    session_id: { type: DataTypes.UUID, allowNull: true },
    message_id: { type: DataTypes.UUID, allowNull: true },
    user_id: { type: DataTypes.INTEGER, allowNull: true },
    // Desfecho do turno após a validação anti-alucinação:
    //  corrected - a reescrita automática limpou todas as divergências
    //  blocked   - divergência persistiu e o texto foi SUBSTITUÍDO pelos dados reais
    //  warned    - divergência sem dados autoritativos p/ reescrever; entregue com aviso
    outcome: { type: DataTypes.ENUM('corrected', 'blocked', 'warned'), allowNull: false },
    attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    // Valores/nomes acusados pelo detector: [{ value, parsed, kind }]
    suspicious: { type: DataTypes.JSONB, allowNull: true, defaultValue: null },
    original_text: { type: DataTypes.TEXT, allowNull: true },
    final_text: { type: DataTypes.TEXT, allowNull: true },
    // Snapshot do turno: pergunta do usuário, modelo/pool, tools chamadas, latência.
    context: { type: DataTypes.JSONB, allowNull: true, defaultValue: null },
    // Triagem no Brain Studio (aba Validação): admin marca como revisado.
    reviewed: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },

    // ── O VEREDITO ───────────────────────────────────────────────────────────
    // A trava acertou ou atrapalhou? É a única pergunta que diz se ela deve
    // ficar como está, endurecer ou sair. Sem isto, "corrected/blocked/warned"
    // só conta o que a trava FEZ, nunca se estava certa ao fazer.
    //   'alucinacao'     - o valor acusado não existia; a trava acertou
    //   'falso_positivo' - o valor era real; a resposta certa foi penalizada
    //   'inconclusivo'   - não dá para dizer com o que ficou guardado
    verdict: { type: DataTypes.STRING(20), allowNull: true },
    verdict_by: { type: DataTypes.INTEGER, allowNull: true },
    verdict_at: { type: DataTypes.DATE, allowNull: true },
    verdict_note: { type: DataTypes.TEXT, allowNull: true },

    // Retrato compacto do que as consultas do turno devolveram. Sem ele o
    // veredito seria chute: para dizer se "143" estava no dado, é preciso ver
    // o dado. Guardado no momento do incidente porque a consulta não se repete.
    evidence: { type: DataTypes.JSONB, allowNull: true, defaultValue: null },
  }, {
    tableName: 'eme_validation_incidents',
    underscored: true,
    timestamps: true,
  });
  return EmeValidationIncident;
};
