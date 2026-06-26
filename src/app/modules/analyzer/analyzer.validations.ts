export type EvidenceVerdict =
| "consistent"
| "inconsistent"
| "insufficient_data";

export type CaseType =
| "wrong_transfer"
| "payment_failed"
| "refund_request"
| "duplicate_payment"
| "merchant_settlement_delay"
| "agent_cash_in_issue"
| "phishing_or_social_engineering"
| "other";

export type Severity =
| "low"
| "medium"
| "high"
| "critical";

export type Department =
| "customer_support"
| "dispute_resolution"
| "payments_ops"
| "merchant_operations"
| "agent_operations"
| "fraud_risk";

export type TransactionType =
| "transfer"
| "payment"
| "cash_in"
| "cash_out"
| "settlement"
| "refund";

export type TransactionStatus =
| "completed"
| "failed"
| "pending"
| "reversed";

export interface TransactionHistory {
transaction_id: string;
timestamp: string;
type: TransactionType;
amount: number;
counterparty: string;
status: TransactionStatus;
}

export interface AnalyzeTicketRequest {
ticket_id: string;
complaint: string;
language?: "en" | "bn" | "mixed";
channel?:
| "in_app_chat"
| "call_center"
| "email"
| "merchant_portal"
| "field_agent";
user_type?: "customer" | "merchant" | "agent" | "unknown";
campaign_context?: string;
transaction_history?: TransactionHistory[];
metadata?: Record<string, unknown>;
}

export const validateRequest = (
body: AnalyzeTicketRequest
): string[] => {
const errors: string[] = [];

if (!body.ticket_id?.trim()) {
errors.push("ticket_id is required");
}

if (!body.complaint?.trim()) {
errors.push("complaint is required");
}

if (
body.language &&
!["en", "bn", "mixed"].includes(body.language)
) {
errors.push("invalid language");
}

if (
body.channel &&
![
"in_app_chat",
"call_center",
"email",
"merchant_portal",
"field_agent",
].includes(body.channel)
) {
errors.push("invalid channel");
}

if (
body.user_type &&
![
"customer",
"merchant",
"agent",
"unknown",
].includes(body.user_type)
) {
errors.push("invalid user_type");
}

if (
body.transaction_history &&
!Array.isArray(body.transaction_history)
) {
errors.push(
"transaction_history must be an array"
);
}

body.transaction_history?.forEach(
(transaction, index) => {
if (!transaction.transaction_id) {
errors.push(
`transaction_history[${index}].transaction_id is required`
);
}

  if (!transaction.timestamp) {
    errors.push(
      `transaction_history[${index}].timestamp is required`
    );
  }

  if (
    typeof transaction.amount !== "number"
  ) {
    errors.push(
      `transaction_history[${index}].amount must be a number`
    );
  }

  if (!transaction.counterparty) {
    errors.push(
      `transaction_history[${index}].counterparty is required`
    );
  }

  if (
    ![
      "transfer",
      "payment",
      "cash_in",
      "cash_out",
      "settlement",
      "refund",
    ].includes(transaction.type)
  ) {
    errors.push(
      `transaction_history[${index}].type is invalid`
    );
  }

  if (
    ![
      "completed",
      "failed",
      "pending",
      "reversed",
    ].includes(transaction.status)
  ) {
    errors.push(
      `transaction_history[${index}].status is invalid`
    );
  }
}


);

return errors;
};
