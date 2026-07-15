import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import usersRouter from "./users";
import termsRouter from "./terms";
import rosteringRouter from "./rostering";
import feedbackRouter from "./feedback";
import usageRouter from "./usage";
import uploadsRouter from "./uploads";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(usersRouter);
router.use(termsRouter);
router.use(rosteringRouter);
router.use(feedbackRouter);
router.use(usageRouter);
router.use(uploadsRouter);

export default router;
