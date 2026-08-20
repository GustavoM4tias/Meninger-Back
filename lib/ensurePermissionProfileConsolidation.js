// lib/ensurePermissionProfileConsolidation.js
//
// Consolidação dos perfis AVULSOS nos perfis PADRÃO por departamento
// (decisão de 2026-08-19). O modelo é "perfil vivo": editar o perfil propaga
// na hora para todo mundo que aponta para ele — só funciona de verdade se cada
// departamento tiver UM perfil padrão, mantido pelo seed
// (seedDepartmentDefaultProfiles), em vez de perfis paralelos criados à mão.
//
//   "Gestor Comercial" (avulso, 5 usuários) → "Padrão - Comercial"
//   "Novos Negócios"   (avulso, 0 usuários) → desativado
//
// NINGUÉM PODE PERDER ALÇADA NA VIRADA: as telas que existiam só no perfil
// avulso viram EXCEÇÃO do usuário (routes_extra), que é exatamente para isso.
// O caminho contrário (telas que o perfil padrão tem a mais) é ganho e fica —
// é o padrão do departamento assumindo.
//
// Idempotente: assim que o perfil de origem fica inativo, tudo vira no-op.

import db from '../models/sequelize/index.js';

// origem (perfil avulso) → destino (perfil padrão), pelo NOME.
// Destino null = só desativa a origem (perfil sem uso).
const CONSOLIDATIONS = [
    { from: 'Gestor Comercial', to: 'Padrão - Comercial' },
    { from: 'Novos Negócios', to: null },
];

const asArray = (v) => (Array.isArray(v) ? v.filter(Boolean).map(String) : []);

async function findActiveProfile(name) {
    return db.PermissionProfile.findOne({ where: { name, active: true } });
}

/**
 * Move os usuários de um perfil para outro preservando as alçadas efetivas.
 * @returns {Promise<number>} usuários migrados
 */
async function migrateUsers(fromProfile, toProfile) {
    const users = await db.User.findAll({
        where: { permission_profile_id: fromProfile.id },
        attributes: ['id', 'username'],
    });
    if (!users.length) return 0;

    const fromRoutes = asArray(fromProfile.routes);
    const toRoutes = new Set(asArray(toProfile.routes));
    // O que existia no perfil antigo e NÃO existe no novo precisa sobreviver
    // como exceção do usuário, senão a virada tira acesso de gente.
    const carryOver = fromRoutes.filter(r => !toRoutes.has(r));

    for (const user of users) {
        const [perm] = await db.UserPermission.findOrCreate({
            where: { userId: user.id },
            defaults: {
                userId: user.id, routes: [], routes_extra: [], routes_removed: [],
                routes_migrated: true,
            },
        });
        if (carryOver.length) {
            const extra = new Set(asArray(perm.routes_extra));
            let changed = false;
            for (const r of carryOver) {
                if (!extra.has(r)) { extra.add(r); changed = true; }
            }
            if (changed) await perm.update({ routes_extra: [...extra], routes_migrated: true });
        }
        await db.User.update(
            { permission_profile_id: toProfile.id },
            { where: { id: user.id } },
        );
    }
    return users.length;
}

/**
 * Grants de empreendimento do perfil de origem (subject_type='profile') passam
 * para o destino. Hoje nenhum perfil tem grant, mas deixar isso implícito seria
 * uma perda silenciosa de escopo no dia em que tiver.
 */
async function migrateProfileGrants(fromProfile, toProfile) {
    const rows = await db.EnterpriseGrant.findAll({
        where: { subject_type: 'profile', subject_id: fromProfile.id },
        attributes: ['enterprise_id'], raw: true,
    });
    if (!rows.length) return 0;

    const existing = await db.EnterpriseGrant.findAll({
        where: { subject_type: 'profile', subject_id: toProfile.id },
        attributes: ['enterprise_id'], raw: true,
    });
    const have = new Set(existing.map(r => Number(r.enterprise_id)));
    const missing = rows
        .map(r => Number(r.enterprise_id))
        .filter(id => !have.has(id));

    if (missing.length) {
        await db.EnterpriseGrant.bulkCreate(missing.map(eid => ({
            subject_type: 'profile', subject_id: toProfile.id, enterprise_id: eid,
        })));
    }
    await db.EnterpriseGrant.destroy({
        where: { subject_type: 'profile', subject_id: fromProfile.id },
    });
    return missing.length;
}

export async function ensurePermissionProfileConsolidation() {
    for (const { from, to } of CONSOLIDATIONS) {
        const fromProfile = await findActiveProfile(from);
        if (!fromProfile) continue; // já consolidado (ou nunca existiu): no-op

        if (!to) {
            await fromProfile.update({ active: false });
            console.log(`✅ [SchemaPatch] Perfil avulso "${from}" desativado (sem uso).`);
            continue;
        }

        const toProfile = await findActiveProfile(to);
        if (!toProfile) {
            // O perfil padrão nasce do seedDepartmentDefaultProfiles, que roda
            // DEPOIS deste patch no primeiro boot de um banco novo. Sem destino,
            // não mexe em nada: no boot seguinte a consolidação acontece.
            console.warn(`⚠️  [SchemaPatch] Perfil padrão "${to}" ainda não existe; consolidação de "${from}" adiada.`);
            continue;
        }

        const moved = await migrateUsers(fromProfile, toProfile);
        const grants = await migrateProfileGrants(fromProfile, toProfile);
        await fromProfile.update({ active: false });

        console.log(
            `✅ [SchemaPatch] Perfil "${from}" consolidado em "${to}": `
            + `${moved} usuário(s) migrado(s)${grants ? `, ${grants} grant(s) de empreendimento` : ''}.`
        );
    }
}

export default ensurePermissionProfileConsolidation;
