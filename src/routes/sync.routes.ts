import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { adminMiddleware } from "../middlewares/admin.middleware";
import { syncKeyMiddleware } from "../middlewares/syncKey.middleware";
import * as syncController from "../controllers/sync.controller";

const router = Router();

// Sin JWT: lo llama el agente de cada local con la llave compartida.
router.post("/sales", syncKeyMiddleware, syncController.sales);
router.get("/status", authMiddleware, adminMiddleware, syncController.status);

export default router;
