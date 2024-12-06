// api/utils/responseHandler.js
const responseHandler = {
  success: (res, data) => {
    console.log('Success:', data); // Log adicional para depuração
    res.status(200).json({
      success: true,
      data,
    });
  },
  error: (res, error) => {
    console.error('Error:', error); // Log para identificar o problema
    res.status(500).json({
      success: false,
      error: typeof error === 'string' ? error : error.message || 'Erro inesperado no servidor.',
    });
  },
};

export default responseHandler;