// api/utils/responseHandler.js
const responseHandler = {
  success: (res, data) => {
    res.status(200).json({
      success: true,
      data,
    });
  },
  // status opcional (default 500, preserva o comportamento anterior).
  // Segurança: só devolvemos ao cliente a mensagem quando ela é uma STRING
  // (mensagem deliberada e segura). Objetos Error podem trazer detalhe
  // interno/DB — esses são logados no servidor e o cliente recebe genérico.
  error: (res, error, status = 500) => {
    console.error('Error:', error); // log completo no servidor
    const message = typeof error === 'string' ? error : 'Erro inesperado no servidor.';
    res.status(status).json({
      success: false,
      error: message,
    });
  },
};

export default responseHandler;
