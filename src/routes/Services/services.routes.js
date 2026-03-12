const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../../middleware/auth");

const {
  createService,
  getClientServices,
  getEmployeeServices,
  updateServiceStatus,
  getMetrics,
  getChartLineData,
  getServicesByProfession,
} = require("./repository/Service");

// 🔐 Todas protegidas

// Criar serviço (cliente cria)
router.post("/", authMiddleware, createService);

// Listar serviços do cliente logado
router.get("/client", authMiddleware, getClientServices);

// Listar serviços do funcionário logado
router.get("/employee", authMiddleware, getEmployeeServices);

// Atualizar status
router.patch("/:id/status", authMiddleware, updateServiceStatus);

// Métricas personalizadas
router.get("/metrics", authMiddleware, getMetrics);

// Dados do gráfico de linha
router.get("/chart/line", authMiddleware, getChartLineData);

// Dados de distribuição por profissão
router.get("/chart/professions", authMiddleware, getServicesByProfession);

module.exports = router;
