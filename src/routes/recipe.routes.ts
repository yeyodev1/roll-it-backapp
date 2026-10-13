import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { adminMiddleware } from "../middlewares/admin.middleware";
import { uploadMiddleware } from "../middlewares/upload.middleware";
import * as recipeController from "../controllers/recipe.controller";

const router = Router();

router.use(authMiddleware, adminMiddleware);

router.get("/", recipeController.list);
router.post("/import", uploadMiddleware.single("file"), recipeController.importFile);
router.get("/product/:productId", recipeController.getByProduct);
router.put("/product/:productId", recipeController.upsert);
router.delete("/product/:productId", recipeController.remove);

export default router;
