/**
 * src/middleware/attachGeo.js
 *
 * Lightweight middleware that attaches geo data to every request WITHOUT
 * blocking anything. Mount this globally before your routes so that
 * req.geoCountry is always available for logging, analytics, and
 * personalisation — even on routes that don't enforce geo restrictions.
 *
 * The actual enforcement (blocking) is done by geoRestrict() on specific routers.
 */

import geoip from "geoip-lite";
import { GEO_BYPASS } from "../config/geo.js";

export function attachGeo(req, _res, next) {
  if (GEO_BYPASS) {
    req.geoCountry = "BYPASS";
    req.geoIp = req.ip;
    return next();
  }

  const raw = (req.ip ?? "").replace(/^::ffff:/, "");
  const geo = raw ? geoip.lookup(raw) : null;

  req.geoCountry = geo?.country ?? null;
  req.geoIp = raw || null;

  next();
}
