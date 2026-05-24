// scheduler/academyOnboardingScheduler.js
//
// Diariamente às 6h, aplica todas as regras de onboarding ATIVAS — varre os
// usuários elegíveis e cria assignments USER scope que ainda não existem.
//
// Idempotente. Roda barato em volume pequeno (~minutos); para enterprise,
// considerar trigger no momento de mudança do User em vez de scan diário.

import cron from 'node-cron';
import onboardingService from '../services/academy/onboardingService.js';

async function runOnboardingCheck() {
    try {
        const result = await onboardingService.applyAll();
        if (result.assignmentsCreated > 0) {
            console.log(`[academyOnboarding] aplicou ${result.rulesApplied} regra(s), criou ${result.assignmentsCreated} assignment(s).`);
        }
    } catch (err) {
        console.error('[academyOnboarding]', err);
    }
}

export function startAcademyOnboardingScheduler() {
    cron.schedule('0 6 * * *', () => {
        runOnboardingCheck().catch(err => console.error('[academyOnboarding]', err));
    });
    console.log('[academyOnboardingScheduler] iniciado (cron: 0 6 * * *)');
}

export { runOnboardingCheck };
