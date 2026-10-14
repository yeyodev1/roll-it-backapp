import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { adminMiddleware } from "../middlewares/admin.middleware";
import { syncKeyMiddleware } from "../middlewares/syncKey.middleware";
import { reportUploadMiddleware } from "../middlewares/upload.middleware";
import * as syncController from "../controllers/sync.controller";

const router = Router();

// Sin JWT: lo llama el agente de cada local con la llave compartida.
router.post("/sales", syncKeyMiddleware, syncController.sales);
router.get("/status", authMiddleware, adminMiddleware, syncController.status);
// Mientras no haya agente en el local: el dueño sube el reporte de ventas de SmartMenu.
router.post(
  "/upload",
  authMiddleware,
  adminMiddleware,
  reportUploadMiddleware,
  syncController.upload,
);

export default router;
