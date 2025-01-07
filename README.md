Para manter a API rodando mesmo após fechar o terminal, instale o PM2:

bash
Copiar código
npm install -g pm2
Inicie a API com PM2:

bash
Copiar código
pm2 start server.js --name api-meninger
Verifique se o processo está rodando:

bash
Copiar código
pm2 list
Salve o estado do PM2 para reiniciar automaticamente após reboot:

bash
Copiar código
pm2 save
pm2 startup

8. Configurar Firewall
Certifique-se de que a porta onde sua API está rodando (por padrão, 5000) está aberta no firewall:

bash
Copiar código
sudo firewall-cmd --add-port=5000/tcp --permanent
sudo firewall-cmd --reload

9. Configurar um Proxy Reverso (Opcional)
Se você quiser acessar sua API via um domínio (como api.meninengenharia.ws), configure um proxy reverso com o Nginx:

Instale o Nginx:

bash
Copiar código
sudo yum install nginx # Para CentOS
sudo apt install nginx # Para Ubuntu/Debian
Edite o arquivo de configuração:

bash
Copiar código
sudo nano /etc/nginx/conf.d/api.conf
Adicione o seguinte conteúdo:

nginx
Copiar código
server {
    listen 80;
    server_name api.meninengenharia.ws;

    location / {
        proxy_pass http://localhost:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
Teste e reinicie o Nginx:

bash
Copiar código
sudo nginx -t
sudo systemctl restart nginx
Agora você pode acessar sua API em http://api.meninengenharia.ws.

10. Testar a API
No navegador ou no Postman, teste sua API:

Localmente no servidor: http://localhost:5000
Remotamente: http://seu-ip-publico:5000 ou http://api.meninengenharia.ws
Se você encontrar algum problema durante o processo, envie os detalhes que eu posso ajudar a corrigir!