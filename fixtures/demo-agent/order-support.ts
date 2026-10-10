export interface OrderApiResponse {
  order: {
    id: string;
    status: string;
    customer?: { email?: string };
    contact?: { primaryEmail?: string };
  };
  apiVersion?: string;
}

export class OrderContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderContractError";
  }
}

/** The production implementation represented by the failing neatlogs trace. */
export function vulnerableGetCustomerEmail(response: OrderApiResponse) {
  // The non-null assertion models the stale v2 contract in the target agent.
  return response.order.customer!.email!.toLowerCase();
}

/** The implementation produced by the demo healing patch. */
export function healedGetCustomerEmail(response: OrderApiResponse) {
  const email = response.order.customer?.email ?? response.order.contact?.primaryEmail;

  if (!email) {
    throw new OrderContractError("Order response is missing a customer email");
  }

  return email.toLowerCase();
}
