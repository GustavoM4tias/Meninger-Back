// api/utils/emailService.js
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
