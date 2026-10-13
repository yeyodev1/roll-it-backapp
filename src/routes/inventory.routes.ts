import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { adminMiddleware } from "../middlewares/admin.middleware";
import { staffMiddleware } from "../middlewares/staff.middleware";
import * as inventoryController from "../controllers/inventory.controller";

const router = Router();

router.use(authMiddleware, staffMiddleware);

router.get("/", inventoryController.list);
router.get("/movements", inventoryController.movements);
router.get("/ask", inventoryController.ask);
router.post("/initial", inventoryController.initial);
router.post("/adjust", inventoryController.adjust);
router.put("/thresholds", adminMiddleware, inventoryController.thresholds);

export default router;
