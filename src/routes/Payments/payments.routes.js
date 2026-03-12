const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../../middleware/auth");
const {
  createPayment,
  listPayments,
  getPaymentsMetrics,
  getPaymentsLineChart,
  getPaymentsStatusChart,
  getPaymentStatusByPreference,
  mercadoPagoWebhook,
  paymentHealthCheck,
} = require("./controller/payments.controller");

// Health check para diagnostic
router.get("/payments/health", paymentHealthCheck);

// Cria uma preferência de pagamento no Checkout Pro (Pix)
router.post("/create-payment", authMiddleware, createPayment);

// Lista pagamentos do usuário autenticado
router.get("/payments", authMiddleware, listPayments);

// Métricas e gráficos de pagamentos
router.get("/payments/metrics", authMiddleware, getPaymentsMetrics);
router.get("/payments/chart/line", authMiddleware, getPaymentsLineChart);
router.get("/payments/chart/status", authMiddleware, getPaymentsStatusChart);
router.get(
  "/payments/status/:preferenceId",
  authMiddleware,
  getPaymentStatusByPreference,
);

// Webhook oficial do Mercado Pago para confirmação automática
router.post("/webhook/mercadopago", express.json(), mercadoPagoWebhook);

module.exports = router;
