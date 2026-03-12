const paymentsService = require("../service/payments.service");

function logError(event, error, extra = {}) {
  console.error(
    JSON.stringify({
      scope: "payments",
      event,
      message: error?.message || "unknown_error",
      stack: error?.stack,
      ...extra,
    }),
  );
}

async function paymentHealthCheck(req, res) {
  try {
    const diagnostics = await paymentsService.getMercadoPagoDiagnostics();

    return res.json({
      status: "ok",
      diagnostics,
    });
  } catch (error) {
    logError("health_check_error", error);
    return res.status(500).json({ error: "Health check failed" });
  }
}

async function createPayment(req, res) {
  try {
    const { service_id: serviceId } = req.body || {};

    if (!serviceId) {
      return res.status(400).json({ error: "service_id é obrigatório" });
    }

    const result = await paymentsService.createPaymentPreference({
      serviceId: Number(serviceId),
      userId: req.user.id,
    });

    return res.status(result.status).json(result.data);
  } catch (error) {
    logError("create_payment_error", error, {
      body: req.body,
      userId: req.user?.id,
    });

    // Retornar mais detalhes do erro para debug
    const errorMessage = error?.message || "Erro ao criar pagamento";
    return res.status(500).json({
      error: errorMessage,
      details:
        process.env.NODE_ENV === "development" ? error?.stack : undefined,
    });
  }
}

async function listPayments(req, res) {
  try {
    const result = await paymentsService.listPaymentsForUser({
      userId: req.user.id,
      role: req.user.role,
    });

    return res.status(result.status).json(result.data);
  } catch (error) {
    logError("list_payments_error", error, {
      userId: req.user?.id,
      role: req.user?.role,
    });

    return res.status(500).json({ error: "Erro ao listar pagamentos" });
  }
}

async function getPaymentsMetrics(req, res) {
  try {
    const result = await paymentsService.getPaymentsMetricsForUser({
      userId: req.user.id,
      role: req.user.role,
    });

    return res.status(result.status).json(result.data);
  } catch (error) {
    logError("get_payments_metrics_error", error, {
      userId: req.user?.id,
      role: req.user?.role,
    });

    return res
      .status(500)
      .json({ error: "Erro ao buscar métricas de pagamentos" });
  }
}

async function getPaymentsLineChart(req, res) {
  try {
    const result = await paymentsService.getPaymentsLineChartForUser({
      userId: req.user.id,
      role: req.user.role,
    });

    return res.status(result.status).json(result.data);
  } catch (error) {
    logError("get_payments_line_chart_error", error, {
      userId: req.user?.id,
      role: req.user?.role,
    });

    return res
      .status(500)
      .json({ error: "Erro ao buscar histórico de pagamentos" });
  }
}

async function getPaymentsStatusChart(req, res) {
  try {
    const result = await paymentsService.getPaymentsStatusChartForUser({
      userId: req.user.id,
      role: req.user.role,
    });

    return res.status(result.status).json(result.data);
  } catch (error) {
    logError("get_payments_status_chart_error", error, {
      userId: req.user?.id,
      role: req.user?.role,
    });

    return res
      .status(500)
      .json({ error: "Erro ao buscar distribuição de pagamentos" });
  }
}

async function getPaymentStatusByPreference(req, res) {
  try {
    const { preferenceId } = req.params;

    if (!preferenceId) {
      return res.status(400).json({ error: "preferenceId é obrigatório" });
    }

    const result = await paymentsService.getPaymentStatusByPreferenceForUser({
      preferenceId,
      userId: req.user.id,
    });

    return res.status(result.status).json(result.data);
  } catch (error) {
    logError("get_payment_status_by_preference_error", error, {
      preferenceId: req.params?.preferenceId,
      userId: req.user?.id,
    });

    return res
      .status(500)
      .json({ error: "Erro ao consultar status do pagamento" });
  }
}

async function mercadoPagoWebhook(req, res) {
  try {
    const result = await paymentsService.processWebhookEvent(req);
    return res.status(result.status).json(result.data);
  } catch (error) {
    logError("mercadopago_webhook_error", error, {
      body: req.body,
      query: req.query,
    });
    return res.status(500).json({ error: "Erro no processamento do webhook" });
  }
}

module.exports = {
  createPayment,
  listPayments,
  getPaymentsMetrics,
  getPaymentsLineChart,
  getPaymentsStatusChart,
  getPaymentStatusByPreference,
  mercadoPagoWebhook,
  paymentHealthCheck,
};
