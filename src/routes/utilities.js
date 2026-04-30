// ─── Replace imports + route handlers in utilities.js ─────────────────────────
import { Router } from "express";
import { validate } from "../middleware/validate.js";
import {
  listBillersQuery,
  billerIdParams,
  billPayBody,
  orderIdParams,
  orderHistoryQuery,
} from "../schemas/utilities.js";
import {
  listBillers,
  getBillerById,
  listBillTypes,
  processBillPayment,
  getReloadlyTransactionStatus,
} from "../services/utilities.js";
import {
  getOrdersByUser,
  getOrderById,
  markCompleted,
  markFailed,
} from "../models/orderQueries.js";
import { OrderLog } from "../models/orderLog.js";

export const utilitiesRouter = Router();

utilitiesRouter.get("/bill-types", async (_req, res, next) => {
  try {
    res.json({ billTypes: await listBillTypes() });
  } catch (err) {
    next(err);
  }
});

utilitiesRouter.get(
  "/billers",
  validate({ query: listBillersQuery }),
  async (req, res, next) => {
    try {
      const billers = await listBillers(req.query);
      res.json({ billers });
    } catch (err) {
      next(err);
    }
  },
);

utilitiesRouter.get(
  "/billers/:id",
  validate({ params: billerIdParams }),
  async (req, res, next) => {
    try {
      const biller = await getBillerById(req.params.id);
      if (!biller) return res.status(404).json({ error: "Biller not found" });
      res.json({ biller });
    } catch (err) {
      next(err);
    }
  },
);

utilitiesRouter.post(
  "/pay",
  validate({ body: billPayBody }),
  async (req, res, next) => {
    try {
      const { order, duplicate } = await processBillPayment({
        firebaseUid: req.firebaseUid,
        ...req.body,
      });
      res.status(duplicate ? 200 : 201).json({ order, duplicate });
    } catch (err) {
      next(err);
    }
  },
);

utilitiesRouter.get(
  "/orders",
  validate({ query: orderHistoryQuery }),
  async (req, res, next) => {
    try {
      const orders = await getOrdersByUser(req.firebaseUid, {
        ...req.query,
        type: "UTILITY",
      });
      res.json({ orders });
    } catch (err) {
      next(err);
    }
  },
);

utilitiesRouter.get(
  "/orders/:orderId",
  validate({ params: orderIdParams }),
  async (req, res, next) => {
    try {
      const order = await getOrderById(req.params.orderId, req.firebaseUid);
      if (!order) return res.status(404).json({ error: "Order not found" });
      res.json({ order });
    } catch (err) {
      next(err);
    }
  },
);

utilitiesRouter.get(
  "/orders/:orderId/refresh",
  validate({ params: orderIdParams }),
  async (req, res, next) => {
    try {
      const order = await getOrderById(req.params.orderId, req.firebaseUid);
      if (!order) return res.status(404).json({ error: "Order not found" });
      if (order.status !== "PROCESSING")
        return res.json({ order, refreshed: false });
      if (!order.reloadly_tx_id) return res.json({ order, refreshed: false });

      let reloadlyTx;
      try {
        reloadlyTx = await getReloadlyTransactionStatus(order.reloadly_tx_id);
      } catch {
        return res.json({
          order,
          refreshed: false,
          reason: "Upstream check failed",
        });
      }

      let updated = order;
      if (reloadlyTx.status === "SUCCESSFUL") {
        updated = await markCompleted(order.id, {
          reloadlyTxId: String(reloadlyTx.id),
          operatorTxId: reloadlyTx.referenceId ?? null,
          reloadlyPayload: reloadlyTx,
        });
        await OrderLog.findOneAndUpdate(
          { orderId: order.id },
          {
            $push: {
              events: {
                event: "ORDER_COMPLETED",
                data: reloadlyTx,
                actor: "system",
              },
            },
          },
        );
      } else if (reloadlyTx.status === "FAILED") {
        updated = await markFailed(order.id, {
          errorMessage: reloadlyTx.message ?? "Reloadly reported failure",
          errorCode: reloadlyTx.code ?? null,
          reloadlyPayload: reloadlyTx,
        });
      }
      res.json({ order: updated, refreshed: true });
    } catch (err) {
      next(err);
    }
  },
);
