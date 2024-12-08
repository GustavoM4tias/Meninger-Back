// import { sendEmail } from './emailService.js';

// (async () => {
//     await sendEmail(
//         'gustavodiniz200513@gmail.com',
//         'Teste de e-mail',
//         '<h1>Este é um teste da Meninger!</h1><p>Se você recebeu este e-mail, a configuração está funcionando!</p>'
//     );
// })();
import { sendEmailWithTemplate } from './emailService.js';

(async () => {
    await sendEmailWithTemplate(
        'gustavodiniz200513@gmail.com',
        'Bem-vindo à Meninger!',
        './templates/emailEventTemplate.html', // Caminho para o template
        replacements
    );
})();

