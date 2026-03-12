const crypto = require("crypto");
const axios = require("axios");
const { MercadoPagoConfig, Preference, Payment } = require("mercadopago");
const paymentsRepository = require("../repository/payments.repository");

function getMercadoPagoClient() {
  const accessToken = process.env.MERCADO_PAGO_ACCESS_TOKEN;

  if (!accessToken) {
    throw new Error("MERCADO_PAGO_ACCESS_TOKEN não configurado");
  }

  return new MercadoPagoConfig({ accessToken });
}

function log(event, payload) {
  console.log(JSON.stringify({ scope: "payments", event, ...payload }));
}

function parseBooleanEnv(value) {
  return String(value || "").toLowerCase() === "true";
}

const EMPLOYEE_GAIN_DIVISOR = 1.2;

function normalizeEmployeeGainAmount(amount) {
  const numericAmount = Number(amount || 0);
  return Number((numericAmount / EMPLOYEE_GAIN_DIVISOR).toFixed(2));
}

function isAutoReturnBackUrlError(error) {
  const message = String(
    error?.message ||
      error?.cause?.message ||
      error?.response?.data?.message ||
      "",
  ).toLowerCase();

  return (
    message.includes("auto_return invalid") ||
    message.includes("back_url.success must be defined")
  );
}

function getTokenType(accessToken) {
  if (!accessToken) return "missing";
  if (accessToken.startsWith("TEST-")) return "test";
  if (accessToken.startsWith("APP_USR-")) return "production";
  return "unknown";
}

async function getPixAvailability(accessToken) {
  if (!accessToken) {
    return {
      pixFound: false,
      pixStatus: "missing_token",
      total: 0,
      error: null,
    };
  }

  try {
    const methodsResponse = await axios.get(
      "https://api.mercadopago.com/v1/payment_methods",
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );

    const paymentMethods = Array.isArray(methodsResponse.data)
      ? methodsResponse.data
      : [];
    const pixMethod = paymentMethods.find((method) => method.id === "pix");

    return {
      pixFound: Boolean(pixMethod),
      pixStatus: pixMethod?.status || "not_found",
      total: paymentMethods.length,
      error: null,
    };
  } catch (error) {
    return {
      pixFound: false,
      pixStatus: "error",
      total: 0,
      error: error?.response?.data?.message || error?.message,
    };
  }
}

async function getMercadoPagoDiagnostics() {
  const accessToken = process.env.MERCADO_PAGO_ACCESS_TOKEN;
  const publicKey = process.env.MERCADO_PAGO_PUBLIC_KEY;
  const webhookUrl = process.env.MERCADO_PAGO_WEBHOOK_URL;

  const diagnostics = {
    tokenConfigured: Boolean(accessToken),
    publicKeyConfigured: Boolean(publicKey),
    webhookUrlConfigured: Boolean(webhookUrl),
    tokenType: getTokenType(accessToken),
    useSandboxCheckout: parseBooleanEnv(
      process.env.MERCADO_PAGO_USE_SANDBOX_CHECKOUT,
    ),
    preferPix: parseBooleanEnv(process.env.MERCADO_PAGO_PREFER_PIX),
    forcePixOnly: parseBooleanEnv(process.env.MERCADO_PAGO_FORCE_PIX_ONLY),
    account: null,
    paymentMethods: {
      pixFound: false,
      pixStatus: "unknown",
      total: 0,
    },
  };

  if (!accessToken) {
    return diagnostics;
  }

  try {
    const [accountResponse, methodsResponse] = await Promise.all([
      axios.get("https://api.mercadopago.com/users/me", {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
      axios.get("https://api.mercadopago.com/v1/payment_methods", {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
    ]);

    const account = accountResponse.data || {};
    const paymentMethods = Array.isArray(methodsResponse.data)
      ? methodsResponse.data
      : [];
    const pixMethod = paymentMethods.find((method) => method.id === "pix");

    diagnostics.account = {
      id: account.id,
      nickname: account.nickname,
      email: account.email,
      country_id: account.country_id,
      site_id: account.site_id,
      status: account.status,
    };

    diagnostics.paymentMethods = {
      pixFound: Boolean(pixMethod),
      pixStatus: pixMethod?.status || "not_found",
      total: paymentMethods.length,
    };
  } catch (error) {
    diagnostics.accountError = {
      message: error?.response?.data?.message || error?.message,
      status: error?.response?.status,
    };
  }

  return diagnostics;
}

function validateWebhookSignatureIfAvailable(req, paymentId) {
  const secret = process.env.MERCADO_PAGO_WEBHOOK_SECRET;
  if (!secret) return true;

  const signatureHeader = req.headers["x-signature"];
  const requestId = req.headers["x-request-id"];

  if (!signatureHeader || !requestId) {
    return false;
  }

  const parts = String(signatureHeader)
    .split(",")
    .map((item) => item.trim())
    .reduce((acc, item) => {
      const [key, value] = item.split("=");
      if (key && value) acc[key] = value;
      return acc;
    }, {});

  const ts = parts.ts;
  const v1 = parts.v1;

  if (!ts || !v1) return false;

  const manifest = `id:${paymentId};request-id:${requestId};ts:${ts};`;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(manifest)
    .digest("hex");

  return expected === v1;
}

async function createPaymentPreference({ serviceId, userId }) {
  await paymentsRepository.ensurePaymentsTable();

  log("create_payment_start", {
    serviceId,
    userId,
  });

  const service = await paymentsRepository.findServiceById(serviceId);

  if (!service) {
    log("service_not_found", { serviceId });
    return { status: 404, data: { error: "Serviço não encontrado" } };
  }

  log("service_found", {
    serviceId,
    clientId: service.client_id,
    value: service.value,
  });

  if (Number(service.client_id) !== Number(userId)) {
    log("permission_denied", {
      serviceClientId: service.client_id,
      requestUserId: userId,
    });
    return {
      status: 403,
      data: { error: "Sem permissão para pagar este serviço" },
    };
  }

  if (!service.value || Number(service.value) <= 0) {
    log("invalid_service_value", { serviceId, value: service.value });
    return {
      status: 400,
      data: { error: "Serviço sem valor válido para pagamento" },
    };
  }

  // MODO DE TESTE: Se usar token "DEMO_MODE", retorna URL fictícia
  if (process.env.MERCADO_PAGO_ACCESS_TOKEN === "DEMO_MODE") {
    log("demo_mode_payment", {
      serviceId,
      amount: service.value,
    });

    const demoPreferenceId = `demo_pref_${serviceId}_${Date.now()}`;
    await paymentsRepository.upsertPendingPayment({
      serviceId: service.id,
      preferenceId: demoPreferenceId,
      amount: Number(service.value),
    });

    return {
      status: 200,
      data: {
        init_point:
          "https://www.mercadopago.com.br/checkout/v1/redirect?preference-id=DEMO",
        sandbox_init_point:
          "https://sandbox.mercadopago.com.br/checkout/test?preference-id=DEMO",
        preference_id: demoPreferenceId,
        service_id: service.id,
        status: "pending",
        demo: true,
        message:
          "⚠️ MODO DEMONSTRAÇÃO - Use token real MERCADO_PAGO_ACCESS_TOKEN para produção",
      },
    };
  }

  const client = getMercadoPagoClient();
  const preferenceApi = new Preference(client);
  const publicKey = process.env.MERCADO_PAGO_PUBLIC_KEY;

  const webhookUrl = process.env.MERCADO_PAGO_WEBHOOK_URL;
  const frontendBaseUrl =
    process.env.FRONTEND_BASE_URL || "http://localhost:3000";
  if (!webhookUrl) {
    return {
      status: 500,
      data: { error: "MERCADO_PAGO_WEBHOOK_URL não configurada" },
    };
  }

  const preferencePayload = {
    items: [
      {
        title: service.description || `Serviço #${service.id}`,
        quantity: 1,
        unit_price: Number(service.value),
        currency_id: "BRL",
      },
    ],
    external_reference: String(service.id),
    notification_url: webhookUrl,
    back_urls: {
      success: "http://localhost:3000/home",
      failure: "https://seusite.com/payment/failure",
      pending: "https://seusite.com/payment/pending",
    },
    auto_return: "approved",
    metadata: {
      service_id: String(service.id),
    },
    statement_descriptor: "MYSERVICES",
  };

  const successRedirectUrl = `${frontendBaseUrl}/home`;
  preferencePayload.back_urls = {
    success: successRedirectUrl,
    pending: successRedirectUrl,
    failure: successRedirectUrl,
  };
  preferencePayload.auto_return = "approved";

  const preferPix = parseBooleanEnv(process.env.MERCADO_PAGO_PREFER_PIX);
  const forcePixOnly = parseBooleanEnv(process.env.MERCADO_PAGO_FORCE_PIX_ONLY);
  const pixAvailability = await getPixAvailability(
    process.env.MERCADO_PAGO_ACCESS_TOKEN,
  );

  log("pix_availability_checked", {
    serviceId: service.id,
    pixFound: pixAvailability.pixFound,
    pixStatus: pixAvailability.pixStatus,
    methodsTotal: pixAvailability.total,
    error: pixAvailability.error,
  });

  if (forcePixOnly && !pixAvailability.pixFound) {
    return {
      status: 400,
      data: {
        error:
          "PIX não está disponível para a conta/token Mercado Pago atual. Desative MERCADO_PAGO_FORCE_PIX_ONLY ou use uma conta com PIX habilitado.",
      },
    };
  }

  if ((preferPix || forcePixOnly) && pixAvailability.pixFound) {
    preferencePayload.payment_methods = {
      default_payment_method_id: "pix",
    };
  }

  if (forcePixOnly) {
    preferencePayload.payment_methods = {
      ...preferencePayload.payment_methods,
      excluded_payment_types: [
        { id: "credit_card" },
        { id: "debit_card" },
        { id: "ticket" },
        { id: "atm" },
      ],
      installments: 1,
      default_installments: 1,
    };
  }

  let preferenceResponse;
  try {
    log("preference_payload_sending", {
      serviceId: service.id,
      amount: Number(service.value),
      payloadKeys: Object.keys(preferencePayload),
    });

    try {
      preferenceResponse = await preferenceApi.create({
        body: preferencePayload,
      });
    } catch (firstError) {
      if (!isAutoReturnBackUrlError(firstError)) {
        throw firstError;
      }

      log("preference_retry_without_auto_return", {
        serviceId: service.id,
        reason: firstError?.message,
      });

      const fallbackPayload = { ...preferencePayload };
      delete fallbackPayload.auto_return;
      delete fallbackPayload.back_urls;

      preferenceResponse = await preferenceApi.create({
        body: fallbackPayload,
      });
    }

    log("preference_created_response", {
      preferenceId: preferenceResponse.id,
      serviceId: service.id,
      hasInitPoint: Boolean(preferenceResponse.init_point),
      hasSandboxInitPoint: Boolean(preferenceResponse.sandbox_init_point),
      responseKeys: Object.keys(preferenceResponse),
    });
  } catch (error) {
    const isAuthError =
      error?.message?.includes("UNAUTHORIZED") ||
      error?.message?.includes("policy") ||
      error?.message?.includes("unauthorized");

    const errorMessage = isAuthError
      ? "Token de acesso Mercado Pago inválido ou expirado. Verifique a variável MERCADO_PAGO_ACCESS_TOKEN no arquivo .env"
      : error?.message || "Erro ao criar preferência de pagamento";

    log("preference_creation_failed", {
      serviceId: service.id,
      error: errorMessage,
      isAuthError,
      originalError: error?.message,
      stack: error?.stack,
    });

    return {
      status: 401,
      data: {
        error: errorMessage,
        hint: isAuthError
          ? "Obtenha um novo token em https://www.mercadopago.com.br/developers/panel"
          : undefined,
      },
    };
  }

  let paymentRecord;
  try {
    paymentRecord = await paymentsRepository.upsertPendingPayment({
      serviceId: service.id,
      preferenceId: preferenceResponse.id,
      amount: Number(service.value),
    });
    log("payment_record_created", {
      paymentId: paymentRecord.id,
      serviceId: service.id,
    });
  } catch (error) {
    log("payment_record_failed", {
      serviceId: service.id,
      preferenceId: preferenceResponse?.id,
      error: error?.message,
    });
    throw error;
  }

  await paymentsRepository.updateServiceStatus(service.id, "PENDING");

  log("create_payment_success", {
    serviceId: service.id,
    preferenceId: preferenceResponse.id,
    paymentTableId: paymentRecord.id,
    amount: Number(service.value),
    hasPublicKey: Boolean(publicKey),
  });

  const useSandboxCheckout = parseBooleanEnv(
    process.env.MERCADO_PAGO_USE_SANDBOX_CHECKOUT,
  );
  const checkoutUrl = useSandboxCheckout
    ? preferenceResponse.sandbox_init_point || preferenceResponse.init_point
    : preferenceResponse.init_point || preferenceResponse.sandbox_init_point;

  log("checkout_url_selected", {
    serviceId: service.id,
    useSandboxCheckout,
    checkoutUrl,
  });

  console.log("Checkout URL:", checkoutUrl);
  console.log("Init Point:", preferenceResponse.init_point);

  return {
    status: 200,
    data: {
      checkout_url: checkoutUrl,
      init_point: preferenceResponse.init_point,
      sandbox_init_point: preferenceResponse.sandbox_init_point,
      preference_id: preferenceResponse.id,
      service_id: service.id,
      status: "pending",
    },
  };
}

async function processWebhookEvent(req) {
  await paymentsRepository.ensurePaymentsTable();

  const eventType = req.body?.type || req.query?.type || "";
  const action = req.body?.action || "";
  const isPaymentEvent =
    eventType === "payment" || String(action).startsWith("payment.");

  if (!isPaymentEvent) {
    log("webhook_ignored", { reason: "not_payment_event", eventType, action });
    return { status: 200, data: { ok: true, ignored: true } };
  }

  const paymentId =
    req.body?.data?.id ||
    req.query?.["data.id"] ||
    req.query?.id ||
    req.body?.id;

  if (!paymentId) {
    log("webhook_invalid", { reason: "missing_payment_id" });
    return { status: 400, data: { error: "payment_id não informado" } };
  }

  const signatureOk = validateWebhookSignatureIfAvailable(req, paymentId);
  if (!signatureOk) {
    log("webhook_invalid_signature", { paymentId: String(paymentId) });
    return { status: 401, data: { error: "assinatura inválida" } };
  }

  const alreadyProcessed = await paymentsRepository.findPaymentByPaymentId(
    String(paymentId),
  );
  if (alreadyProcessed && alreadyProcessed.status === "approved") {
    log("webhook_idempotent", {
      paymentId: String(paymentId),
      preferenceId: alreadyProcessed.preference_id,
    });
    return { status: 200, data: { ok: true, idempotent: true } };
  }

  const client = getMercadoPagoClient();
  const paymentApi = new Payment(client);
  const paymentDetails = await paymentApi.get({ id: String(paymentId) });

  const mpStatus = String(paymentDetails.status || "").toLowerCase();
  const preferenceId = String(
    paymentDetails.order?.id ||
      paymentDetails.metadata?.preference_id ||
      paymentDetails.additional_info?.items?.[0]?.id ||
      paymentDetails.preference_id ||
      "",
  );

  const targetPreferenceId =
    preferenceId || String(paymentDetails.metadata?.preference_id || "");

  let paymentRecord = null;
  if (targetPreferenceId) {
    paymentRecord =
      await paymentsRepository.findPaymentByPreferenceId(targetPreferenceId);
  }

  if (!paymentRecord && paymentDetails.external_reference) {
    paymentRecord = await paymentsRepository.findPaymentByServiceId(
      Number(paymentDetails.external_reference),
    );
  }

  if (!paymentRecord) {
    log("webhook_no_payment_record", {
      paymentId: String(paymentId),
      preferenceId: targetPreferenceId,
      status: mpStatus,
    });
    return {
      status: 200,
      data: { ok: true, ignored: true, reason: "payment_record_not_found" },
    };
  }

  if (mpStatus === "approved") {
    const updated = await paymentsRepository.markPaymentApproved({
      paymentId: String(paymentId),
      preferenceId: paymentRecord.preference_id,
    });

    if (updated) {
      await paymentsRepository.updateServiceStatus(updated.service_id, "PAID");
    }

    log("webhook_payment_approved", {
      paymentId: String(paymentId),
      preferenceId: paymentRecord.preference_id,
      serviceId: updated?.service_id,
    });

    return { status: 200, data: { ok: true, status: "approved" } };
  }

  if (mpStatus === "rejected" || mpStatus === "cancelled") {
    const updated = await paymentsRepository.markPaymentFailed({
      paymentId: String(paymentId),
      preferenceId: paymentRecord.preference_id,
    });

    if (updated) {
      await paymentsRepository.updateServiceStatus(
        updated.service_id,
        "FAILED",
      );
    }

    log("webhook_payment_failed", {
      paymentId: String(paymentId),
      preferenceId: paymentRecord.preference_id,
      serviceId: updated?.service_id,
      mpStatus,
    });

    return { status: 200, data: { ok: true, status: "failed" } };
  }

  log("webhook_unhandled_status", {
    paymentId: String(paymentId),
    preferenceId: paymentRecord.preference_id,
    mpStatus,
  });

  return { status: 200, data: { ok: true, ignored: true, mpStatus } };
}

async function listPaymentsForUser({ userId, role }) {
  await paymentsRepository.ensurePaymentsTable();

  const normalizedRole = String(role || "").toUpperCase();
  const isEmployee = normalizedRole === "EMPLOYEE";

  const payments = await paymentsRepository.listPaymentsByUser({
    userId,
    role,
  });

  const normalizedPayments = isEmployee
    ? payments.map((payment) => ({
        ...payment,
        amount: normalizeEmployeeGainAmount(payment.amount),
      }))
    : payments;

  return {
    status: 200,
    data: normalizedPayments,
  };
}

async function getPaymentStatusByPreferenceForUser({ preferenceId, userId }) {
  await paymentsRepository.ensurePaymentsTable();

  let paymentRecord = await paymentsRepository.findPaymentByPreferenceId(
    String(preferenceId),
  );

  if (!paymentRecord) {
    return {
      status: 404,
      data: { error: "Pagamento não encontrado para esta preferência" },
    };
  }

  const service = await paymentsRepository.findServiceById(
    paymentRecord.service_id,
  );
  if (!service) {
    return {
      status: 404,
      data: { error: "Serviço vinculado ao pagamento não encontrado" },
    };
  }

  const hasPermission =
    Number(service.client_id) === Number(userId) ||
    Number(service.employee_id) === Number(userId);

  if (!hasPermission) {
    return {
      status: 403,
      data: { error: "Sem permissão para consultar este pagamento" },
    };
  }

  if (String(paymentRecord.status || "").toLowerCase() === "pending") {
    try {
      const accessToken = process.env.MERCADO_PAGO_ACCESS_TOKEN;
      if (accessToken && accessToken !== "DEMO_MODE") {
        const searchResponse = await axios.get(
          "https://api.mercadopago.com/v1/payments/search",
          {
            headers: { Authorization: `Bearer ${accessToken}` },
            params: {
              external_reference: String(service.id),
              sort: "date_created",
              criteria: "desc",
              limit: 1,
            },
          },
        );

        const latestPayment = Array.isArray(searchResponse.data?.results)
          ? searchResponse.data.results[0]
          : null;

        if (latestPayment) {
          const mpStatus = String(latestPayment.status || "").toLowerCase();

          if (mpStatus === "approved") {
            await paymentsRepository.markPaymentApproved({
              paymentId: String(latestPayment.id),
              preferenceId: paymentRecord.preference_id,
            });
            await paymentsRepository.updateServiceStatus(service.id, "PAID");
          } else if (mpStatus === "rejected" || mpStatus === "cancelled") {
            await paymentsRepository.markPaymentFailed({
              paymentId: String(latestPayment.id),
              preferenceId: paymentRecord.preference_id,
            });
            await paymentsRepository.updateServiceStatus(service.id, "FAILED");
          }

          paymentRecord =
            (await paymentsRepository.findPaymentByPreferenceId(
              String(preferenceId),
            )) || paymentRecord;
        }
      }
    } catch (error) {
      log("status_sync_with_mp_failed", {
        preferenceId: String(preferenceId),
        serviceId: service.id,
        error: error?.message,
      });
    }
  }

  return {
    status: 200,
    data: {
      preference_id: paymentRecord.preference_id,
      payment_id: paymentRecord.payment_id,
      status: paymentRecord.status,
      service_id: paymentRecord.service_id,
      service_status: service.status,
      amount: Number(paymentRecord.amount || 0),
    },
  };
}

async function getPaymentsMetricsForUser({ userId, role }) {
  await paymentsRepository.ensurePaymentsTable();

  const normalizedRole = String(role || "").toUpperCase();
  const row = await paymentsRepository.getPaymentMetricsByUser({
    userId,
    role,
  });

  if (normalizedRole === "CLIENT") {
    return {
      status: 200,
      data: {
        role: normalizedRole,
        services_count: Number(row?.paid_count || 0),
        pending_count: Number(row?.pending_count || 0),
        total_spent: Number(row?.total_spent || 0),
        total_pending: Number(row?.total_pending || 0),
      },
    };
  }

  const totalEarned = normalizeEmployeeGainAmount(row?.total_earned || 0);
  const totalSpent = Number(row?.total_spent || 0);
  const totalToReceive = normalizeEmployeeGainAmount(
    row?.total_to_receive || 0,
  );

  return {
    status: 200,
    data: {
      role: normalizedRole,
      total_earned: totalEarned,
      total_spent: totalSpent,
      total_to_receive: totalToReceive,
      services_done: Number(row?.services_done || 0),
      pending_receivables: Number(row?.pending_receivables || 0),
      saldo_liquido: totalEarned - totalSpent,
    },
  };
}

async function getPaymentsLineChartForUser({ userId, role }) {
  await paymentsRepository.ensurePaymentsTable();

  const normalizedRole = String(role || "").toUpperCase();
  const chartRows = await paymentsRepository.getPaymentLineChartByUser({
    userId,
    role,
  });

  if (normalizedRole === "CLIENT") {
    const data = (chartRows || []).map((row) => ({
      date: new Date(row.date).toLocaleDateString("pt-BR", {
        day: "numeric",
        month: "short",
      }),
      gastos: Number(row.gastos || 0),
    }));

    return {
      status: 200,
      data: {
        role: normalizedRole,
        data,
      },
    };
  }

  const ganhosRows = chartRows?.ganhos || [];
  const gastosRows = chartRows?.gastos || [];

  const allDates = new Set();
  ganhosRows.forEach((row) => allDates.add(String(row.date)));
  gastosRows.forEach((row) => allDates.add(String(row.date)));

  const data = Array.from(allDates)
    .sort()
    .map((date) => {
      const ganhoRow = ganhosRows.find((row) => String(row.date) === date);
      const gastoRow = gastosRows.find((row) => String(row.date) === date);

      return {
        date: new Date(date).toLocaleDateString("pt-BR", {
          day: "numeric",
          month: "short",
        }),
        ganhos: normalizeEmployeeGainAmount(ganhoRow?.ganhos || 0),
        gastos: Number(gastoRow?.gastos || 0),
      };
    });

  return {
    status: 200,
    data: {
      role: normalizedRole,
      data,
    },
  };
}

async function getPaymentsStatusChartForUser({ userId, role }) {
  await paymentsRepository.ensurePaymentsTable();

  const rows = await paymentsRepository.getPaymentStatusChartByUser({
    userId,
    role,
  });
  const colorByStatus = {
    approved: "#10B981",
    pending: "#F59E0B",
    failed: "#EF4444",
  };
  const labelByStatus = {
    approved: "Pago",
    pending: "Pendente",
    failed: "Falhou",
  };

  const data = (rows || []).map((row) => {
    const status = String(row.status || "").toLowerCase();
    return {
      name: labelByStatus[status] || status,
      value: Number(row.total || 0),
      color: colorByStatus[status] || "#6B7280",
    };
  });

  return {
    status: 200,
    data,
  };
}

module.exports = {
  createPaymentPreference,
  processWebhookEvent,
  getMercadoPagoDiagnostics,
  listPaymentsForUser,
  getPaymentsMetricsForUser,
  getPaymentsLineChartForUser,
  getPaymentsStatusChartForUser,
  getPaymentStatusByPreferenceForUser,
};
