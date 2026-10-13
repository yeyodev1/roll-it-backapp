import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { adminMiddleware } from "../middlewares/admin.middleware";
import { staffMiddleware } from "../middlewares/staff.middleware";
import * as productController from "../controllers/product.controller";

const router = Router();

router.get("/", authMiddleware, staffMiddleware, productController.list);
router.post("/", authMiddleware, adminMiddleware, productController.create);
router.put("/:id", authMiddleware, adminMiddleware, productController.update);

export default router;
