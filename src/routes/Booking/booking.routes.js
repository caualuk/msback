const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../../middleware/auth");

const {
  listServices,
  createCatalogService,
  listProfessionals,
  updateWorkingHours,
  getMyWorkingHours,
  updateMyWorkingHours,
  getAvailableTimes,
  createAppointment,
  deleteAppointment,
} = require("./repository/Booking");

// Endpoints solicitados
router.get("/services", listServices);
router.get("/professionals", listProfessionals);
router.get("/professionals/:id/available-times", getAvailableTimes);
router.get("/professionals/me/working-hours", authMiddleware, getMyWorkingHours);
router.put("/professionals/me/working-hours", authMiddleware, updateMyWorkingHours);
router.post("/appointments", authMiddleware, createAppointment);
router.delete("/appointments/:id", authMiddleware, deleteAppointment);

// Endpoints de cadastro/manutenção
router.post("/services/catalog", authMiddleware, createCatalogService);
router.put("/professionals/:id/working-hours", authMiddleware, updateWorkingHours);

module.exports = router;
