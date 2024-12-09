// api/utils/emailService.js
import fs from 'fs';
import path from 'path';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST, // Servidor SMTP
    port: process.env.EMAIL_PORT, // Porta SMTP
    secure: process.env.EMAIL_SECURE === 'true', // true para 465, false para outras
    auth: {
        user: process.env.EMAIL_USER, // Usuário SMTP
        pass: process.env.EMAIL_PASS, // Senha SMTP
    },
    tls: {
        rejectUnauthorized: false, // Ignora problemas de certificado
    },
    debug: true, // Log detalhado
});

// Verifica conexão com o servidor SMTP
transporter.verify((error, success) => {
    if (error) {
        console.error('Erro na configuração do email:', error);
    } else {
        console.log('Servidor de email configurado corretamente');
    }
});

export const sendEmail = async (to, subject, html) => {
    try {
        const info = await transporter.sendMail({
            from: process.env.EMAIL_FROM, // Endereço de envio
            to,
            subject,
            html,
        });
        console.log('E-mail enviado:', info.messageId);
    } catch (error) {
        console.error('Erro ao enviar email:', error);
    }
};

export const sendEmailWithTemplate = async (to, subject, templatePath, replacements) => {
    try {
        // 1. Carrega o template HTML do arquivo indicado
        const template = fs.readFileSync(
            path.resolve(templatePath), // Resolve o caminho absoluto para o arquivo
            'utf-8' // Lê o conteúdo do arquivo como texto (em formato UTF-8)
        );

        // 2. Função para processar valores aninhados
        const replacePlaceholders = (template, data, prefix = '') => {
            Object.entries(data).forEach(([key, value]) => {
                const placeholder = `{{${prefix}${key}}}`;
                if (typeof value === 'object' && !Array.isArray(value)) {
                    // Recursivamente substitui objetos aninhados
                    template = replacePlaceholders(template, value, `${prefix}${key}.`);
                } else if (Array.isArray(value)) {
                    // Substitui arrays com placeholders específicos (exemplo: {{images[0]}})
                    value.forEach((item, index) => {
                        template = template.replace(new RegExp(`{{${prefix}${key}\\[${index}\\]}}`, 'g'), item);
                    });
                } else {
                    // Substitui valores simples
                    template = template.replace(new RegExp(placeholder, 'g'), value);
                }
            });
            return template;
        };

        // Substitui os placeholders no template
        const html = replacePlaceholders(template, replacements);

        // 3. Envia o e-mail usando o Nodemailer
        const info = await transporter.sendMail({
            from: process.env.EMAIL_FROM, // Endereço do remetente (ex.: suporte@meusite.com)
            to, // Destinatário (e-mail para quem será enviado)
            subject, // Assunto do e-mail
            html, // Conteúdo HTML com as variáveis substituídas
        });

        console.log('E-mail enviado:', info.messageId); // Confirmação de envio
    } catch (error) {
        console.error('Erro ao enviar email:', error); // Captura e exibe erros
    }
};


// OUTRAS OPÇÕES 
// transporter.sendMail({
//     from: 'suporte@meusite.com', // Remetente
//     to: 'destinatario@exemplo.com', // Destinatário
//     cc: 'cc@exemplo.com', // Destinatário em cópia
//     bcc: 'bcc@exemplo.com', // Destinatário em cópia oculta
//     subject: 'Título do E-mail', // Assunto
//     text: 'Mensagem apenas em texto', // Mensagem em texto puro
//     html: '<h1>Mensagem em HTML</h1>', // Mensagem com HTML
//     attachments: [
//         {
//             filename: 'arquivo.pdf', // Nome do arquivo
//             path: './caminho/arquivo.pdf', // Caminho do arquivo local
//         },
//     ],
// });

