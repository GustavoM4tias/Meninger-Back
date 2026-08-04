// lib/ensureUserEmailNormalization.js
//
// E-mails de usuário passaram a ser comparados SEM case em todo o app (login,
// vínculo do login Microsoft, merge da aprovação de primeiro acesso). Este
// patch idempotente alinha os dados existentes:
//   1. minúscula os e-mails onde isso NÃO colide com outro usuário;
//   2. loga os pares que continuam duplicados (mesmo e-mail em dois cadastros)
//      — são a pessoa duplicada de verdade (organograma em dobro); o admin
//      resolve pela tela de Usuários excluindo o registro que sobrou.
import db from '../models/sequelize/index.js';

export async function ensureUserEmailNormalization() {
    const [, meta] = await db.sequelize.query(`
        UPDATE users u
        SET email = lower(email)
        WHERE email <> lower(email)
          AND NOT EXISTS (
            SELECT 1 FROM users v
            WHERE v.id <> u.id AND lower(v.email) = lower(u.email)
          )
    `);
    const fixed = meta?.rowCount ?? 0;
    if (fixed) console.log(`✅ [UserEmail] ${fixed} e-mail(s) de usuário normalizados para minúsculo.`);

    const dups = await db.sequelize.query(`
        SELECT lower(email) AS email,
               array_agg(id ORDER BY id) AS ids,
               array_agg(username ORDER BY id) AS usernames
        FROM users
        GROUP BY lower(email)
        HAVING COUNT(*) > 1
    `, { type: db.Sequelize.QueryTypes.SELECT });

    for (const d of dups) {
        console.warn(
            `⚠️  [UserEmail] Cadastros DUPLICADOS para ${d.email}: ids ${d.ids.join(', ')} ` +
            `(${d.usernames.join(' / ')}). Exclua o duplicado na tela de Usuários para tirar a pessoa em dobro do organograma.`
        );
    }
}
