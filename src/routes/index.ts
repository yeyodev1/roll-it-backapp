import express, { Application } from "express";
import authRoutes from "./auth.routes";
import healthRoutes from "./health.routes";
import cronRoutes from "./cron.routes";
import branchRoutes from "./branch.routes";
import productRoutes from "./product.routes";
import ingredientRoutes from "./ingredient.routes";
import recipeRoutes from "./recipe.routes";
import inventoryRoutes from "./inventory.routes";
import invoiceRoutes from "./invoice.routes";
import syncRoutes from "./sync.routes";
import dashboardRoutes from "./dashboard.routes";
import userRoutes from "./user.routes";
import waiterRoutes from "./waiter.routes";

function routerApi(app: Application) {
  const router = express.Router();
  app.use("/api", router);

  router.use("/health", healthRoutes);
  router.use("/auth", authRoutes);
  router.use("/cron", cronRoutes);
  router.use("/branches", branchRoutes);
  router.use("/products", productRoutes);
  router.use("/ingredients", ingredientRoutes);
  router.use("/recipes", recipeRoutes);
  router.use("/inventory", inventoryRoutes);
  router.use("/invoices", invoiceRoutes);
  router.use("/sync", syncRoutes);
  router.use("/dashboard", dashboardRoutes);
  router.use("/users", userRoutes);
  router.use("/waiters", waiterRoutes);
}

export default routerApi;
