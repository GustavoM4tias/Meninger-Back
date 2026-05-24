// scripts/marketing-smoke.js
//
// Smoke test da Fase 3 (Captação + LPs). Requer o backend rodando em
// localhost:5000 e a Railway PG acessível via .env. Cria um lead_form de
// teste, chama a API de página (que o renderer da LP usa), submete um lead
// como se fosse o navegador, e imprime a trilha de eventos + payload do CV.

import 'dotenv/config';
import pg from 'pg';

const PORT = process.env.PORT || 5000;
const BASE = `http://localhost:${PORT}`;
const SLUG = 'lp-smoke-' + Date.now().toString(36);

const client = new pg.Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    ssl: { rejectUnauthorized: false },
});

const sep = (label) => console.log('\n── ' + label + ' ──');
const dump = (label, value) => {
    sep(label);
    if (typeof value === 'string') console.log(value);
    else console.log(JSON.stringify(value, null, 2));
};

async function main() {
    await client.connect();

    // 1) Cria um form bonito de teste via SQL.
    dump('1) INSERT lead_forms — slug=' + SLUG, 'Criando form com page_config + fields_config customizados');
    const insertRes = await client.query(
        `INSERT INTO lead_forms (
            slug, name, active, midia_slug, cv_origem, bound_empreendimentos, tags,
            consent_required, consent_text, consent_text_version,
            fields_config, page_config,
            created_at, updated_at
         ) VALUES ($1,$2,true,$3,'SI',$4::jsonb,$5::jsonb,true,$6,'v1',$7::jsonb,$8::jsonb,NOW(),NOW())
         RETURNING id, slug, name, active, midia_slug, cv_origem, bound_empreendimentos`,
        [
            SLUG,
            'LP Smoke Test (gerado pelo Claude)',
            'lp-smoke-test',
            JSON.stringify([10]),                              // MOND (idempreendimento CV)
            JSON.stringify(['smoke-test', 'fase-3']),
            'Autorizo o contato e concordo com a política de privacidade.',
            JSON.stringify([
                { key: 'nome',      label: 'Nome',     type: 'text',  enabled: true, required: true  },
                { key: 'email',     label: 'E-mail',   type: 'email', enabled: true, required: true  },
                { key: 'telefone',  label: 'Telefone', type: 'tel',   enabled: true, required: true  },
                { key: 'documento', label: 'CPF',      type: 'text',  enabled: true, required: false },
            ]),
            JSON.stringify({
                title: 'Conheça o MOND — Smoke Test',
                subtitle: 'LP gerada automaticamente pelo teste de fumaça da Fase 3',
                accent_color: '#10b981',
                cta_button_text: 'Quero saber mais',
                success_title: 'Recebemos!',
                success_message: 'Em breve nosso time entra em contato.',
            }),
        ]
    );
    const formRow = insertRes.rows[0];
    dump('   formulário criado na DB', formRow);

    // 2) GET /forms/<slug>/page — endpoint que o renderer da LP chama.
    sep('2) GET /api/marketing/public/forms/' + SLUG + '/page');
    const pageResp = await fetch(`${BASE}/api/marketing/public/forms/${SLUG}/page`);
    const pageJson = await pageResp.json();
    console.log('   HTTP', pageResp.status);
    dump('   resposta (config que a LP usa pra renderizar)', pageJson);

    if (!pageResp.ok || !pageJson.ok) {
        throw new Error('Endpoint de página não retornou ok=true.');
    }

    // 3) POST /forms/<slug>/submit — simula o submit do formulário.
    sep('3) POST /api/marketing/public/forms/' + SLUG + '/submit');
    const submitResp = await fetch(`${BASE}/api/marketing/public/forms/${SLUG}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            nome: 'Fulano Smoke',
            email: 'fulano.smoke@example.com',
            telefone: '14999990000',
            documento: '12345678900',
            utm_source: 'claude-smoke',
            utm_campaign: 'fase-3-test',
            utm_medium: 'organic',
            landing_url: `http://lp.localhost:5173/${SLUG}`,
            consent: true,
        }),
    });
    const submitJson = await submitResp.json();
    console.log('   HTTP', submitResp.status);
    dump('   resposta do submit', submitJson);

    if (!submitResp.ok || !submitJson.ok) {
        throw new Error('Submit não retornou ok=true.');
    }

    // 4) Espera 2s pro despacho async terminar.
    sep('4) Aguardando 2s pra o despacho async concluir...');
    await new Promise(r => setTimeout(r, 2000));

    // 5) Confere inbound_leads.
    const leadRows = await client.query(
        `SELECT id, channel, status, nome, email, telefone, documento, midia_slug, cv_origem,
                bound_empreendimentos, utm_source, utm_campaign, dispatch_attempts,
                is_reentry, cv_idlead, last_error, created_at
           FROM inbound_leads
           WHERE source_form_id = $1
           ORDER BY created_at DESC LIMIT 5`,
        [formRow.id]
    );
    dump('5) inbound_leads gerados pelo form', leadRows.rows);

    if (!leadRows.rows.length) {
        throw new Error('Nenhum inbound_lead foi gravado!');
    }

    // 6) Timeline de eventos.
    const leadId = leadRows.rows[0].id;
    const events = await client.query(
        `SELECT id, event_type, status_from, status_to, message, actor, created_at
           FROM inbound_lead_events
           WHERE inbound_lead_id = $1
           ORDER BY id ASC`,
        [leadId]
    );
    dump('6) inbound_lead_events — TIMELINE completa', events.rows);

    // 7) Payload do CV (do evento dry_run).
    const dryRunEvent = await client.query(
        `SELECT detail FROM inbound_lead_events
          WHERE inbound_lead_id = $1 AND event_type='dry_run'
          ORDER BY id DESC LIMIT 1`,
        [leadId]
    );
    if (dryRunEvent.rows[0]?.detail?.payload) {
        dump('7) Payload que IRIA pro CV CRM (dry-run)', dryRunEvent.rows[0].detail.payload);
    }

    await client.end();
    sep('✅ SMOKE OK');
    console.log('   • Form na DB: id=' + formRow.id + ' slug=' + SLUG);
    console.log('   • Lead na DB: id=' + leadId + ' status=' + leadRows.rows[0].status);
    console.log('   • URL da LP (quando subir o front): http://lp.localhost:5173/' + SLUG);
    console.log('   • Inspecione tudo em Marketing › Captação / Formulários quando subir o Office.');
}

main().catch(e => {
    console.error('\n❌ SMOKE FALHOU:', e.message);
    console.error(e.stack);
    process.exit(1);
});
