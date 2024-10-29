// api/utils/responseHandler.js
const responseHandler = {
  success: (res, data) => {
    res.status(200).json({
      success: true,
      data,
    });
  },
  error: (res, error) => {
    res.status(500).json({
      success: false,
      error: error.message || 'O servidor encontrou uma situação inesperada.',
    });
  },
};

export default responseHandler;