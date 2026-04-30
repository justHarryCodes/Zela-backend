// ─── Replace imports + route handlers in giftcards.js ────────────────────────
import { Router } from "express";
import { validate } from "../middleware/validate.js";
import {
  listProductsQuery,
  productIdParams,
  giftCardOrderBody,
  orderIdParams,
  orderHistoryQuery,
} from "../schemas/giftcards.js";
import {
  listProducts,
  getProductById,
  purchaseGiftCard,
  getRedeemCodes,
} from "../services/giftcards.js";
import { getOrdersByUser, getOrderById } from "../models/orderQueries.js";

export const giftcardsRouter = Router();

giftcardsRouter.get(
  "/products",
  validate({ query: listProductsQuery }),
  async (req, res, next) => {
    try {
      const { includeRange, includeFixed, ...rest } = req.query;
      const products = await listProducts({
        ...rest,
        includeRange: includeRange !== "false",
        includeFixed: includeFixed !== "false",
      });
      res.json({ products });
    } catch (err) {
      next(err);
    }
  },
);

giftcardsRouter.get(
  "/products/:productId",
  validate({ params: productIdParams }),
  async (req, res, next) => {
    try {
      const product = await getProductById(req.params.productId);
      if (!product) return res.status(404).json({ error: "Product not found" });
      res.json({ product });
    } catch (err) {
      next(err);
    }
  },
);

giftcardsRouter.post(
  "/order",
  validate({ body: giftCardOrderBody }),
  async (req, res, next) => {
    try {
      const { order, duplicate } = await purchaseGiftCard({
        firebaseUid: req.firebaseUid,
        ...req.body,
      });
      res.status(duplicate ? 200 : 201).json({ order, duplicate });
    } catch (err) {
      next(err);
    }
  },
);

giftcardsRouter.get(
  "/orders",
  validate({ query: orderHistoryQuery }),
  async (req, res, next) => {
    try {
      const orders = await getOrdersByUser(req.firebaseUid, {
        ...req.query,
        type: "GIFTCARD",
      });
      res.json({ orders });
    } catch (err) {
      next(err);
    }
  },
);

giftcardsRouter.get(
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

giftcardsRouter.get(
  "/orders/:orderId/code",
  validate({ params: orderIdParams }),
  async (req, res, next) => {
    try {
      const order = await getOrderById(req.params.orderId, req.firebaseUid);
      if (!order) return res.status(404).json({ error: "Order not found" });
      if (order.status !== "COMPLETED") {
        return res.status(409).json({
          error: "Redeem code not yet available",
          status: order.status,
        });
      }
      const codes = await getRedeemCodes(req.params.orderId, req.firebaseUid);
      console.log(
        `[giftcards] Code accessed — orderId: ${req.params.orderId} uid: ${req.firebaseUid}`,
      );
      res.json({ codes });
    } catch (err) {
      next(err);
    }
  },
);
