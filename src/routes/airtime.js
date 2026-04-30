import { Router } from "express";
import { validate } from "../middleware/validate.js";
import {
  listOperatorsQuery,
  detectOperatorQuery,
  operatorIdParams,
  bundlesParams,
  airtimeTopupBody,
  dataTopupBody,
  orderIdParams,
  orderHistoryQuery,
} from "../schemas/airtime.js";
import {
  listOperators,
  detectOperator,
  getOperatorById,
  listDataBundles,
  processTopup,
} from "../services/airtime.js";
import { getOrdersByUser, getOrderById } from "../models/orderQueries.js";

export const airtimeRouter = Router();
export const dataRouter = Router();

// ─── Operators ─────────────────────────────────────────────────────────────────

airtimeRouter.get(
  "/operators",
  validate({ query: listOperatorsQuery }),
  async (req, res, next) => {
    try {
      const { countryCode, page, size } = req.query;
      const operators = await listOperators(countryCode, { page, size });

      // ── DEV: log exact Reloadly operator names so we can sync nameHints ──
      if (countryCode) {
        console.log(
          `[operators:${countryCode}] ${operators.length} found:\n` +
            operators.map((o) => `  id=${o.id}  name="${o.name}"`).join("\n"),
        );
      }
      // ─────────────────────────────────────────────────────────────────────

      res.json({ operators });
    } catch (err) {
      next(err);
    }
  },
);

airtimeRouter.get(
  "/operators/detect",
  validate({ query: detectOperatorQuery }),
  async (req, res, next) => {
    try {
      const { phone, countryCode, airtimeOnly } = req.query;
      const operator = await detectOperator(
        phone,
        countryCode,
        airtimeOnly === "true",
      );

      // ── DEV: log detected operator name ──────────────────────────────────
      console.log(
        `[operators:detect] phone=${phone} country=${countryCode} → ` +
          (operator ? `id=${operator.id} name="${operator.name}"` : "no match"),
      );
      // ─────────────────────────────────────────────────────────────────────

      res.json({ operator });
    } catch (err) {
      next(err);
    }
  },
);

airtimeRouter.get(
  "/operators/:id",
  validate({ params: operatorIdParams }),
  async (req, res, next) => {
    try {
      const operator = await getOperatorById(req.params.id);
      res.json({ operator });
    } catch (err) {
      next(err);
    }
  },
);

// ─── Data bundles ──────────────────────────────────────────────────────────────

dataRouter.get(
  "/bundles/:operatorId",
  validate({ params: bundlesParams }),
  async (req, res, next) => {
    try {
      const bundles = await listDataBundles(req.params.operatorId);
      res.json({ bundles });
    } catch (err) {
      next(err);
    }
  },
);

// ─── Topups ────────────────────────────────────────────────────────────────────

airtimeRouter.post(
  "/topup",
  validate({ body: airtimeTopupBody }),
  async (req, res, next) => {
    try {
      const { order, duplicate } = await processTopup({
        firebaseUid: req.firebaseUid,
        type: "AIRTIME",
        ...req.body,
      });
      res.status(duplicate ? 200 : 201).json({ order, duplicate });
    } catch (err) {
      next(err);
    }
  },
);

dataRouter.post(
  "/topup",
  validate({ body: dataTopupBody }),
  async (req, res, next) => {
    try {
      const { order, duplicate } = await processTopup({
        firebaseUid: req.firebaseUid,
        type: "DATA",
        ...req.body,
      });
      res.status(duplicate ? 200 : 201).json({ order, duplicate });
    } catch (err) {
      next(err);
    }
  },
);

// ─── Order history ─────────────────────────────────────────────────────────────

airtimeRouter.get(
  "/orders",
  validate({ query: orderHistoryQuery }),
  async (req, res, next) => {
    try {
      const orders = await getOrdersByUser(req.firebaseUid, req.query);
      res.json({ orders });
    } catch (err) {
      next(err);
    }
  },
);

airtimeRouter.get(
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
