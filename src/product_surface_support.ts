import { assertRequiredTables } from "./schema_contract.js";
type WithTx = <T>(fn: (c: any) => Promise<T>) => Promise<T>;

import { SITON_PLATFORM_FEE_RATE } from "./platform_fee_money.js";
import { SITON_PLATFORM_FEE_VAT_RATE } from "./runtime_config.js";

export const DEFAULT_SELLER_ID = "seller-default";
export const DEFAULT_AFFILIATE_CODE = "affiliate-demo";
export const DEFAULT_AFFILIATE_NAME = "Affiliate Demo";

let ensurePromise: Promise<void> | null = null;

export function isChargedMoneyState(moneyState: string | null | undefined) {
  return moneyState === "ChargedSuccess" || moneyState === "RecoveredCharge";
}

// Siton platform fee base = everything actually collected from the buyer
// (price x qty + delivery). Seller-side buyer VAT is not subtracted here. The fee itself is the system
// constant SITON_PLATFORM_FEE_RATE = 0.08. Distributors do NOT receive a fee.
export function summarizeMoney(args: {
  grossAmount: number;
  vatAmount?: number;
}) {
  const grossAmount = Number(args.grossAmount || 0);
  const vatAmount = Math.max(0, Number(args.vatAmount || 0));
  const feeBaseAmount = roundMoney(Math.max(0, grossAmount));
  const sitonFeeBaseAmount = roundMoney(feeBaseAmount * SITON_PLATFORM_FEE_RATE);
  const sitonFeeVatAmount = roundMoney(sitonFeeBaseAmount * SITON_PLATFORM_FEE_VAT_RATE);
  const sitonFeeTotalAmount = roundMoney(sitonFeeBaseAmount + sitonFeeVatAmount);
  return {
    gross_amount: grossAmount,
    vat_amount: roundMoney(vatAmount),
    fee_base_amount: feeBaseAmount,
    siton_fee_rate: SITON_PLATFORM_FEE_RATE,
    siton_fee_vat_rate: SITON_PLATFORM_FEE_VAT_RATE,
    siton_fee_base_amount: sitonFeeBaseAmount,
    siton_fee_vat_amount: sitonFeeVatAmount,
    siton_fee_total_amount: sitonFeeTotalAmount,
    siton_fee_amount: sitonFeeTotalAmount,
    seller_net_amount: roundMoney(grossAmount - sitonFeeTotalAmount)
  };
}

export function roundMoney(value: number) {
  // Use Math.round with scaling to avoid toFixed floating-point artifacts
  return Math.round((Number(value) || 0) * 100) / 100;
}

export async function ensureRemainingProductSurfaceTables(withTx: WithTx) {
  await withTx(async c=>assertRequiredTables(c,["seller_accounts","seller_sessions","affiliate_accounts","affiliate_attributions","distributor_sessions","buyer_sessions","buyer_resume_contexts","support_tickets","deal_chat_messages","deal_delivery_options","deal_images","seller_security_events"]));
}
