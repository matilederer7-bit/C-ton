/**
 * R9A — canonical VAT authority for the customer charge.
 *
 * Business truth this module protects:
 * - The Siton fee is exactly 8% of the authoritative customer charge base,
 *   including delivery/shipping and all applicable charged components,
 *   EXCLUDING VAT. The VAT portion of the customer charge must therefore be
 *   an explicit, authoritative input — never an invented rule.
 * - Product and delivery components may carry different VAT treatment; both
 *   rates are explicit configuration, not code-invented tax law.
 *
 * Modes:
 * - 'synthetic_zero' (default): explicit synthetic configuration for
 *   staging/demo/mock money. VAT is 0 by declared synthetic policy, and the
 *   snapshot says so. This is what every pre-R9A ledger row effectively used.
 * - 'explicit': SITON_VAT_RATE_PRODUCT / SITON_VAT_RATE_DELIVERY (fractions
 *   of the GROSS charge component that are VAT-exclusive-rate based, e.g.
 *   0.18) supplied by business/legal policy. Rates are applied as
 *   gross-inclusive: vat = gross - gross / (1 + rate).
 *
 * Fail-closed rule: real-provider activation (non-mock payment mode in a
 *  sandbox/live environment, and always in production) requires 'explicit'
 * mode. Enforced in production_guards and asserted here.
 */

export type VatAuthorityMode = "synthetic_zero" | "explicit";

export type CustomerVatSnapshot = {
  vat_mode: VatAuthorityMode;
  vat_amount: number;
  product_vat_amount: number;
  delivery_vat_amount: number;
  product_vat_rate: number;
  delivery_vat_rate: number;
};

function roundMoney(value: number) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function readRate(name: string): number | null {
  const raw = String(process.env[name] ?? "").trim();
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed >= 1) {
    throw new Error(`${name} must be a fraction in [0, 1), got "${raw}"`);
  }
  return parsed;
}

export function vatAuthorityMode(): VatAuthorityMode {
  const raw = String(process.env.SITON_VAT_MODE || "synthetic_zero").trim().toLowerCase();
  if (raw === "explicit") return "explicit";
  if (raw === "synthetic_zero" || raw === "") return "synthetic_zero";
  throw new Error(`SITON_VAT_MODE must be "synthetic_zero" or "explicit", got "${raw}"`);
}

export function vatAuthorityConfig(): {
  mode: VatAuthorityMode;
  product_rate: number;
  delivery_rate: number;
} {
  const mode = vatAuthorityMode();
  if (mode === "synthetic_zero") {
    return { mode, product_rate: 0, delivery_rate: 0 };
  }
  const productRate = readRate("SITON_VAT_RATE_PRODUCT") ?? readRate("SITON_VAT_RATE");
  if (productRate === null) {
    throw new Error("SITON_VAT_MODE=explicit requires SITON_VAT_RATE_PRODUCT (or SITON_VAT_RATE)");
  }
  const deliveryRate = readRate("SITON_VAT_RATE_DELIVERY") ?? productRate;
  return { mode, product_rate: productRate, delivery_rate: deliveryRate };
}

/**
 * Compute the VAT portion of a customer charge from its authoritative
 * components. Amounts are gross (VAT-inclusive) major-unit values, matching
 * how Siton prices deals today.
 */
export function computeCustomerChargeVat(args: {
  productGrossAmount: number;
  deliveryGrossAmount: number;
}): CustomerVatSnapshot {
  const config = vatAuthorityConfig();
  const productGross = Math.max(0, Number(args.productGrossAmount || 0));
  const deliveryGross = Math.max(0, Number(args.deliveryGrossAmount || 0));
  const productVat = roundMoney(productGross - productGross / (1 + config.product_rate));
  const deliveryVat = roundMoney(deliveryGross - deliveryGross / (1 + config.delivery_rate));
  return {
    vat_mode: config.mode,
    vat_amount: roundMoney(productVat + deliveryVat),
    product_vat_amount: productVat,
    delivery_vat_amount: deliveryVat,
    product_vat_rate: config.product_rate,
    delivery_vat_rate: config.delivery_rate
  };
}

/**
 * Fail closed for real money: synthetic VAT is only legal for synthetic
 * providers/environments. Called by runtime guards before any real-provider
 * activation is permitted.
 */
export function assertVatAuthorityForRealMoney(context: string) {
  const config = vatAuthorityConfig();
  if (config.mode !== "explicit") {
    throw new Error(
      `${context}: real-provider activation requires SITON_VAT_MODE=explicit with authoritative VAT rates; synthetic_zero VAT is only legal for synthetic money`
    );
  }
}
