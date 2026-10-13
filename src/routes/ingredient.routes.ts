import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { adminMiddleware } from "../middlewares/admin.middleware";
import { staffMiddleware } from "../middlewares/staff.middleware";
import * as ingredientController from "../controllers/ingredient.controller";

const router = Router();

router.get("/", authMiddleware, staffMiddleware, ingredientController.list);
router.post("/", authMiddleware, adminMiddleware, ingredientController.create);
router.put("/:id", authMiddleware, adminMiddleware, ingredientController.update);

export default router;
