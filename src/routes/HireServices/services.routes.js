const express = require("express");
const router = express.Router();

const {
  createServiceRequest,
  acceptServiceRequest,
  declineServiceRequest,
  getEmployeeRequests,
  getClientRequests,
  approveProposal,
  rejectProposal,
  getProposalAvailableSlots,
  scheduleApprovedProposal,
} = require("./repository/HireServices");

const { authMiddleware } = require("../../middleware/auth");

// 🔐 Protegido - Criar solicitação de serviço
router.post("/", authMiddleware, createServiceRequest);

// 🔐 Protegido - Aceitar solicitação e enviar valor
router.patch("/:id/accept", authMiddleware, acceptServiceRequest);

// 🔐 Protegido - Recusar solicitação
router.patch("/:id/decline", authMiddleware, declineServiceRequest);

// 🔐 Protegido - Listar solicitações do funcionário
router.get("/employee", authMiddleware, getEmployeeRequests);

// 🔐 Protegido - Listar solicitações do cliente
router.get("/client", authMiddleware, getClientRequests);

// 🔐 Protegido - Cliente aprova proposta de preço
router.patch("/:id/approve-proposal", authMiddleware, approveProposal);

// 🔐 Protegido - Cliente busca horários disponíveis para proposta aprovada
router.get("/:id/available-slots", authMiddleware, getProposalAvailableSlots);

// 🔐 Protegido - Cliente agenda proposta aprovada
router.patch("/:id/schedule", authMiddleware, scheduleApprovedProposal);

// 🔐 Protegido - Cliente recusa proposta de preço
router.patch("/:id/reject-proposal", authMiddleware, rejectProposal);

module.exports = router;
