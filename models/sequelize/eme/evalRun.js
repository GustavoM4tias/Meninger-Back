// models/sequelize/eme/evalRun.js
//
// Uma rodada da avaliação: quantos casos passaram, quantos falharam e, por
// caso, o que a Eme fez de verdade (tool, args, trecho do texto, motivos da
// reprovação). É a régua: mudou o prompt, roda de novo e compara com a rodada
// anterior.

export default (sequelize, DataTypes) => {
    const EmeEvalRun = sequelize.define('EmeEvalRun', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        label: { type: DataTypes.STRING(160), allowNull: true },
        // running | done | failed
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'running' },
        total: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        passed: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        failed: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        // [{ case_id, title, ok, tool_called, args, text, ms, motivos: [] }]
        results: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        // Versão publicada do cérebro no momento da rodada (null = fallback).
        brain_version_id: { type: DataTypes.UUID, allowNull: true },
        brain_label: { type: DataTypes.STRING(200), allowNull: true },
        started_by: { type: DataTypes.INTEGER, allowNull: true },
        duration_ms: { type: DataTypes.INTEGER, allowNull: true },
        error: { type: DataTypes.TEXT, allowNull: true },
    }, {
        tableName: 'eme_eval_runs',
        underscored: true,
        timestamps: true,
        indexes: [{ fields: ['status'] }, { fields: ['created_at'] }],
    });

    return EmeEvalRun;
};
